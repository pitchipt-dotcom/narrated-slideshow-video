"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeSpeechForIrodori } = require("./manual-speech-normalization");
const { applyPronunciationDictionary, loadPronunciationDictionary } = require("./manual-pronunciation-dictionary");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const SEGMENT_ID_PATTERN = /^seg_[0-9]{3,}$/;
const AUDIO_BLOCK_ID_PATTERN = /^block_[0-9]{3,}$/;
const LOGICAL_ROOT_DEFAULT = "/data/slideshow/manual_jobs";
const DEFAULT_IRODORI_URL = "http://127.0.0.1:8088";
const MIN_WAV_BYTES = 44;
const VOICE_GENERATION_VERSION = 1;
const INTENTIONAL_SILENCE_SECONDS = 0.5;

class SegmentAudioError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "SegmentAudioError";
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.cause = options.cause;
  }
}

function safeMessage(error) {
  if (error instanceof SegmentAudioError) return error.message.slice(0, 1000);
  return "Irodori TTSでセグメント音声を生成できませんでした。";
}

function resolveJobPaths(root, jobId) {
  if (!root) throw new SegmentAudioError("ROOT_NOT_CONFIGURED", "手動ジョブ保存先が設定されていません。");
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new SegmentAudioError("INVALID_JOB_ID", "ジョブIDが不正です。");
  const realRoot = fs.realpathSync(path.resolve(root));
  const jobDirectory = fs.realpathSync(path.resolve(realRoot, jobId));
  if (!jobDirectory.startsWith(`${realRoot}${path.sep}`)) {
    throw new SegmentAudioError("UNSAFE_PATH", "手動ジョブルート外のジョブは更新できません。");
  }
  const jobFile = path.join(jobDirectory, "job.json");
  if (fs.lstatSync(jobFile).isSymbolicLink()) throw new SegmentAudioError("UNSAFE_PATH", "シンボリックリンクのジョブは更新できません。");
  const audioDirectory = path.join(jobDirectory, "audio");
  if (!fs.existsSync(audioDirectory)) fs.mkdirSync(audioDirectory, { mode: 0o770 });
  if (fs.lstatSync(audioDirectory).isSymbolicLink()) throw new SegmentAudioError("UNSAFE_PATH", "シンボリックリンクの音声保存先は使用できません。");
  return { jobFile, audioDirectory };
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o660 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
    throw error;
  }
}

function loadProfile(profilePath, profileName) {
  if (!profilePath) throw new SegmentAudioError("PROFILE_NOT_CONFIGURED", "音声プロファイル設定が指定されていません。");
  const document = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const profile = document && document.profiles && document.profiles[profileName];
  if (!profile || typeof profile.model !== "string" || typeof profile.caption !== "string" || !Number.isInteger(profile.steps)) {
    throw new SegmentAudioError("VOICE_PROFILE_NOT_FOUND", "指定された音声プロファイルを使用できません。");
  }
  return profile;
}

function fixedSeedForProfile(profileName) {
  const digest = crypto.createHash("sha256").update(`manual-voice-v1:${profileName}`, "utf8").digest();
  return (digest.readUInt32BE(0) & 0x7fffffff) || 1;
}

function buildVoiceGeneration(profileName, profile, existing = null) {
  const defaults = {
    model: profile.model,
    caption: profile.caption,
    voice: typeof profile.voice === "string" && profile.voice ? profile.voice : "sample",
    reference_audio: null,
    steps: profile.steps,
    tempo: Number.isFinite(profile.tempo) && profile.tempo > 0 ? profile.tempo : 1,
    duration_scale: 1,
    t_schedule_mode: "linear",
    sway_coeff: -1,
    cfg_guidance_mode: "independent",
    cfg_scale_text: 3,
    cfg_scale_caption: 4,
    cfg_scale_speaker: 0,
    cfg_scale: null,
    cfg_min_t: 0.5,
    cfg_max_t: 1,
    context_kv_cache: true,
  };
  const stored = existing && existing.profile_snapshot;
  const snapshot = stored && typeof stored === "object" ? stored : defaults;
  const seed = existing && Number.isInteger(existing.seed) && existing.seed > 0 && existing.seed <= 0x7fffffff
    ? existing.seed
    : fixedSeedForProfile(profileName);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
  if (stored && existing.profile_fingerprint && existing.profile_fingerprint !== fingerprint) {
    throw new SegmentAudioError("VOICE_CONDITION_MISMATCH", "ジョブの音声生成条件が一致しません。");
  }
  return {
    version: VOICE_GENERATION_VERSION,
    seed,
    profile: profileName,
    conditioning_mode: snapshot.reference_audio || (snapshot.voice && snapshot.voice !== "none") ? "caption_and_reference" : "caption_only",
    reference_audio_used: Boolean(snapshot.reference_audio || (snapshot.voice && snapshot.voice !== "none")),
    profile_fingerprint: fingerprint,
    profile_snapshot: snapshot,
  };
}

function validateVoiceGeneration(value, profileName) {
  const snapshot = value && value.profile_snapshot;
  if (!value || value.version !== VOICE_GENERATION_VERSION || value.profile !== profileName
    || !Number.isInteger(value.seed) || value.seed < 1 || value.seed > 0x7fffffff
    || !snapshot || typeof snapshot.model !== "string" || typeof snapshot.caption !== "string"
    || (snapshot.voice !== undefined && typeof snapshot.voice !== "string")
    || !Number.isInteger(snapshot.steps) || snapshot.steps < 1
    || snapshot.reference_audio !== null) {
    throw new SegmentAudioError("INVALID_VOICE_GENERATION", "ジョブの音声生成条件が不正です。");
  }
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
  if (value.profile_fingerprint !== fingerprint) {
    throw new SegmentAudioError("VOICE_CONDITION_MISMATCH", "ジョブの音声生成条件が一致しません。");
  }
  return value;
}

function buildGenerationData(text, voiceGeneration) {
  const profile = voiceGeneration.profile_snapshot;
  return [
    profile.model, "cpu", "fp32", "cpu", "fp32", text, profile.caption, null,
    profile.steps, 1, String(voiceGeneration.seed), String(Math.max(3, Math.ceil(text.length / 5))), profile.duration_scale,
    profile.t_schedule_mode, profile.sway_coeff, profile.cfg_guidance_mode, profile.cfg_scale_text,
    profile.cfg_scale_caption, profile.cfg_scale_speaker, profile.cfg_scale === null ? "" : String(profile.cfg_scale),
    profile.cfg_min_t, profile.cfg_max_t, profile.context_kv_cache,
    "", "", "", "", "", "", "",
  ];
}

function buildSpeechRequest(text, voiceGeneration, options = {}) {
  const profile = voiceGeneration.profile_snapshot;
  return {
    model: profile.model === "irodori-tts" ? profile.model : "irodori-tts",
    input: text,
    voice: options.irodoriVoice || profile.voice || "sample",
    response_format: "wav",
    speed: profile.tempo,
    irodori: {
      num_steps: profile.steps,
      seed: voiceGeneration.seed,
      caption: profile.caption || undefined,
      duration_scale: profile.duration_scale,
      t_schedule_mode: profile.t_schedule_mode,
      sway_coeff: profile.sway_coeff,
      cfg_scale_text: profile.cfg_scale_text,
      cfg_scale_caption: profile.cfg_scale_caption,
      cfg_scale_speaker: profile.cfg_scale_speaker,
      cfg_guidance_mode: profile.cfg_guidance_mode,
      cfg_min_t: profile.cfg_min_t,
      cfg_max_t: profile.cfg_max_t,
      context_kv_cache: profile.context_kv_cache,
      chunking_enabled: false,
    },
  };
}

function validateWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= MIN_WAV_BYTES
    || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new SegmentAudioError("INVALID_WAV", "Irodori TTSから有効なWAVを取得できませんでした。", { retryable: true });
  }
}

function wavDurationSeconds(buffer) {
  validateWav(buffer);
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bits = buffer.readUInt16LE(34);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32LE(offset + 4);
    if (buffer.toString("ascii", offset, offset + 4) === "data") {
      return Math.round(size / (sampleRate * channels * (bits / 8)) * 1e6) / 1e6;
    }
    offset += 8 + size + (size % 2);
  }
  throw new SegmentAudioError("INVALID_WAV", "WAVの音声時間を取得できませんでした。", { retryable: true });
}

function silentWavBuffer(seconds) {
  const sampleRate = 48000;
  const samples = Math.max(1, Math.round(sampleRate * seconds));
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

async function synthesizeWithIrodori(text, voiceGeneration, options = {}) {
  const baseUrl = String(options.irodoriUrl || DEFAULT_IRODORI_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SegmentAudioError("FETCH_UNAVAILABLE", "HTTPクライアントを使用できません。");
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 600000;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const health = await fetchImpl(`${baseUrl}/health`, { signal });
    if (!health.ok) throw new SegmentAudioError("IRODORI_UNAVAILABLE", "Irodori TTSが利用できません。", { retryable: true });
    const response = await fetchImpl(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildSpeechRequest(text, voiceGeneration, options)),
      signal,
    });
    if (!response.ok) {
      throw new SegmentAudioError("IRODORI_HTTP_ERROR", `Irodori TTSがHTTP ${response.status}を返しました。`, { retryable: response.status >= 500 });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    validateWav(buffer);
    return buffer;
  } catch (error) {
    if (error instanceof SegmentAudioError) throw error;
    throw new SegmentAudioError("IRODORI_REQUEST_FAILED", "Irodori TTSへ接続できませんでした。", { retryable: true, cause: error });
  }
}

function validateJobAndSegment(job, jobId, segmentId) {
  if (!job || job.version !== 2 || job.mode !== "manual" || job.job_id !== jobId) {
    throw new SegmentAudioError("INVALID_MANUAL_JOB", "version 2の手動ジョブだけを処理できます。");
  }
  if (!SEGMENT_ID_PATTERN.test(String(segmentId || ""))) throw new SegmentAudioError("INVALID_SEGMENT_ID", "セグメントIDが不正です。");
  if (!["segments_ready", "waiting_for_tts_service", "audio_generating", "audio_ready"].includes(job.status)
    || !["segments_ready", "waiting_for_tts_service", "audio_generating", "audio_ready"].includes(job.current_stage)) {
    throw new SegmentAudioError("INVALID_JOB_STATE", "音声生成可能な状態ではありません。");
  }
  const segment = Array.isArray(job.segments) ? job.segments.find((item) => item.id === segmentId) : null;
  if (!segment || typeof segment.speech_text !== "string"
    || !segment.audio || typeof segment.audio.status !== "string") {
    throw new SegmentAudioError("INVALID_SEGMENT", "読み上げ用台本を持つセグメントが見つかりません。");
  }
  return segment;
}

function timestamp(options) {
  const now = typeof options.now === "function" ? options.now() : (options.now instanceof Date ? options.now : new Date());
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new SegmentAudioError("INVALID_TIME", "更新日時が不正です。");
  return now.toISOString();
}

async function generateManualSegmentAudio(jobId, segmentId, options = {}) {
  const { jobFile, audioDirectory } = resolveJobPaths(options.root, jobId);
  let job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  let segment = validateJobAndSegment(job, jobId, segmentId);
  const filename = `${segmentId}.wav`;
  const outputFile = path.join(audioDirectory, filename);
  const logicalRoot = String(options.logicalRoot || LOGICAL_ROOT_DEFAULT).replace(/\/+$/, "");
  const logicalPath = path.posix.join(logicalRoot, jobId, "audio", filename);

  if (segment.audio.status === "generated") {
    if (segment.audio.path === logicalPath && fs.existsSync(outputFile)) return { job, segment_id: segmentId, path: logicalPath, reused: true };
    throw new SegmentAudioError("GENERATED_AUDIO_MISSING", "生成済み音声の保存状態が一致しません。");
  }
  if (!['pending', 'failed'].includes(segment.audio.status)) {
    throw new SegmentAudioError("SEGMENT_BUSY", "このセグメントは音声生成中です。");
  }
  if (fs.existsSync(outputFile)) throw new SegmentAudioError("OUTPUT_ALREADY_EXISTS", "未登録の同名音声があるため上書きしません。");

  const profile = loadProfile(options.voiceProfilesPath, job.voice_profile);
  job.voice_generation = buildVoiceGeneration(job.voice_profile, profile, job.voice_generation);
  validateVoiceGeneration(job.voice_generation, job.voice_profile);
  const preparedSpeech = normalizeSpeechForIrodori(segment.speech_text);
  const dictionaryResult = applyPronunciationDictionary(preparedSpeech.text, loadPronunciationDictionary(options.pronunciationDictionaryPath));
  const startedAt = timestamp(options);
  segment.audio = { status: "generating", path: null, duration_seconds: null, error: null };
  job.status = "audio_generating";
  job.current_stage = "audio_generating";
  job.updated_at = startedAt;
  job.attempts = Number(job.attempts || 0) + 1;
  job.error = null;
  job.history.push({ at: startedAt, stage: "audio_generating", message: `${segmentId}の音声生成を開始` });
  atomicWriteJson(jobFile, job);

  let wroteOutput = false;
  try {
    const synthesize = options.synthesize || ((text, voiceGeneration) => synthesizeWithIrodori(text, voiceGeneration, options));
    const wav = preparedSpeech.intentional_silence
      ? silentWavBuffer(INTENTIONAL_SILENCE_SECONDS * job.voice_generation.profile_snapshot.tempo)
      : await synthesize(dictionaryResult.text, job.voice_generation);
    validateWav(wav);
    fs.writeFileSync(outputFile, wav, { flag: "wx", mode: 0o660 });
    wroteOutput = true;
    job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    segment = validateJobAndSegment(job, jobId, segmentId);
    const completedAt = timestamp(options);
    segment.audio = { status: "generated", path: logicalPath, duration_seconds: null, error: null };
    const allGenerated = job.segments.every((item) => item.audio.status === "generated");
    job.status = allGenerated ? "audio_ready" : "audio_generating";
    job.current_stage = job.status;
    job.updated_at = completedAt;
    job.error = null;
    const completedMessage = preparedSpeech.intentional_silence
      ? `${segmentId}の装飾区切りを意図的無音として生成${allGenerated ? "、全セグメント音声を準備" : ""}`
      : (allGenerated ? "全セグメント音声を生成" : `${segmentId}の音声生成を完了`);
    job.history.push({ at: completedAt, stage: job.status, message: completedMessage });
    atomicWriteJson(jobFile, job);
    return { job, segment_id: segmentId, path: logicalPath, reused: false };
  } catch (error) {
    if (wroteOutput) {
      try { fs.unlinkSync(outputFile); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; }
    }
    job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    segment = job.segments.find((item) => item.id === segmentId);
    const failedAt = timestamp(options);
    const message = safeMessage(error);
    segment.audio = { status: "failed", path: null, duration_seconds: null, error: message };
    job.status = error.code === "IRODORI_UNAVAILABLE" ? "waiting_for_tts_service" : "audio_generating";
    job.current_stage = job.status;
    job.updated_at = failedAt;
    job.error = { stage: job.status, code: error.code || "AUDIO_GENERATION_FAILED", message, retryable: error.retryable !== false, segment_id: segmentId };
    job.history.push({ at: failedAt, stage: job.status, message: `${segmentId}の音声生成に失敗` });
    atomicWriteJson(jobFile, job);
    throw error;
  }
}

async function generateManualAudioBlock(jobId, blockId, options = {}) {
  const { jobFile, audioDirectory } = resolveJobPaths(options.root, jobId);
  let job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  if (!job || job.version !== 2 || job.mode !== "manual" || job.job_id !== jobId
    || !Array.isArray(job.audio_blocks) || !AUDIO_BLOCK_ID_PATTERN.test(String(blockId || ""))) {
    throw new SegmentAudioError("INVALID_AUDIO_BLOCK", "音声ブロックを持つ手動ジョブではありません。");
  }
  if (!["segments_ready", "waiting_for_tts_service", "audio_generating", "audio_ready"].includes(job.status)) {
    throw new SegmentAudioError("INVALID_JOB_STATE", "音声生成可能な状態ではありません。");
  }
  let block = job.audio_blocks.find((item) => item.id === blockId);
  if (!block || typeof block.text !== "string" || !block.text.trim()) throw new SegmentAudioError("INVALID_AUDIO_BLOCK", "音声ブロックが不正です。");
  const filename = `${block.id}.wav`;
  const outputFile = path.join(audioDirectory, filename);
  const logicalRoot = String(options.logicalRoot || LOGICAL_ROOT_DEFAULT).replace(/\/+$/, "");
  const logicalPath = path.posix.join(logicalRoot, jobId, "audio", filename);
  if (block.status === "completed") {
    if (block.audio_path === logicalPath && fs.existsSync(outputFile)) return { job, audio_block_id: block.id, path: logicalPath, reused: true };
    throw new SegmentAudioError("GENERATED_AUDIO_MISSING", "生成済み音声ブロックの保存状態が一致しません。");
  }
  if (!["pending", "failed", "quality_failed"].includes(block.status)) throw new SegmentAudioError("AUDIO_BLOCK_BUSY", "この音声ブロックは生成中です。");
  if (fs.existsSync(outputFile)) throw new SegmentAudioError("OUTPUT_ALREADY_EXISTS", "未登録の同名音声があるため上書きしません。");

  const profile = loadProfile(options.voiceProfilesPath, job.voice_profile);
  job.voice_generation = buildVoiceGeneration(job.voice_profile, profile, job.voice_generation);
  validateVoiceGeneration(job.voice_generation, job.voice_profile);
  const preparedSpeech = normalizeSpeechForIrodori(block.text);
  const dictionaryResult = applyPronunciationDictionary(preparedSpeech.text, loadPronunciationDictionary(options.pronunciationDictionaryPath));
  const startedAt = timestamp(options);
  block.status = "generating";
  block.audio_path = null; block.duration_seconds = null; block.started_at = startedAt; block.completed_at = null; block.error = null;
  block.seed = job.voice_generation.seed;
  block.retry_count = Number(block.retry_count || 0);
  job.status = "audio_generating"; job.current_stage = "audio_generating"; job.updated_at = startedAt;
  job.attempts = Number(job.attempts || 0) + 1; job.error = null;
  job.history.push({ at: startedAt, stage: "audio_generating", message: `${block.id}（字幕${block.subtitle_segment_indexes[0] + 1}〜${block.subtitle_segment_indexes.at(-1) + 1}）の音声生成を開始` });
  atomicWriteJson(jobFile, job);

  let wroteOutput = false;
  try {
    const synthesize = options.synthesize || ((text, voiceGeneration) => synthesizeWithIrodori(text, voiceGeneration, options));
    const wav = preparedSpeech.intentional_silence
      ? silentWavBuffer(INTENTIONAL_SILENCE_SECONDS * job.voice_generation.profile_snapshot.tempo)
      : await synthesize(dictionaryResult.text, job.voice_generation);
    validateWav(wav);
    const duration = wavDurationSeconds(wav);
    fs.writeFileSync(outputFile, wav, { flag: "wx", mode: 0o660 });
    wroteOutput = true;
    job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    block = job.audio_blocks.find((item) => item.id === blockId);
    const completedAt = timestamp(options);
    block.status = "completed"; block.audio_path = logicalPath; block.duration_seconds = duration;
    block.completed_at = completedAt; block.error = null; block.seed = job.voice_generation.seed;
    const allGenerated = job.audio_blocks.every((item) => item.status === "completed");
    job.status = allGenerated ? "audio_ready" : "audio_generating"; job.current_stage = job.status; job.updated_at = completedAt; job.error = null;
    job.history.push({ at: completedAt, stage: job.status, message: allGenerated ? "全音声ブロックを生成" : `${block.id}の音声生成を完了` });
    atomicWriteJson(jobFile, job);
    return { job, audio_block_id: block.id, path: logicalPath, duration_seconds: duration, reused: false };
  } catch (error) {
    if (wroteOutput) try { fs.unlinkSync(outputFile); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; }
    job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    block = job.audio_blocks.find((item) => item.id === blockId);
    const failedAt = timestamp(options);
    const message = safeMessage(error);
    block.status = "failed"; block.audio_path = null; block.duration_seconds = null; block.completed_at = failedAt;
    block.error = message; block.retry_count = Number(block.retry_count || 0) + 1;
    job.status = error.code === "IRODORI_UNAVAILABLE" ? "waiting_for_tts_service" : "audio_generating";
    job.current_stage = job.status; job.updated_at = failedAt;
    job.error = { stage: job.status, code: error.code || "AUDIO_GENERATION_FAILED", message, retryable: error.retryable !== false, audio_block_id: blockId };
    job.history.push({ at: failedAt, stage: job.status, message: `${blockId}の音声生成に失敗` });
    atomicWriteJson(jobFile, job);
    throw error;
  }
}

module.exports = {
  DEFAULT_IRODORI_URL,
  INTENTIONAL_SILENCE_SECONDS,
  LOGICAL_ROOT_DEFAULT,
  SegmentAudioError,
  buildGenerationData,
  buildSpeechRequest,
  buildVoiceGeneration,
  fixedSeedForProfile,
  generateManualAudioBlock,
  generateManualSegmentAudio,
  silentWavBuffer,
  synthesizeWithIrodori,
  validateWav,
  wavDurationSeconds,
};
