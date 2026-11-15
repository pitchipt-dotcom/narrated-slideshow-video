"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { normalizeSpeechForIrodori } = require("./manual-speech-normalization");
const { applyPronunciationDictionary, loadPronunciationDictionary } = require("./manual-pronunciation-dictionary");
const { hasAudioBlocks } = require("./manual-audio-blocks");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const SEGMENT_ID_PATTERN = /^seg_[0-9]{3,}$/;
const SAMPLE_RATE = 16000;
const MAX_DECODE_BYTES = 256 * 1024 * 1024;

class AudioQualityError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AudioQualityError";
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.cause = options.cause;
  }
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

function resolveJob(root, jobId) {
  if (!root) throw new AudioQualityError("ROOT_NOT_CONFIGURED", "手動ジョブ保存先が設定されていません。");
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new AudioQualityError("INVALID_JOB_ID", "ジョブIDが不正です。");
  const realRoot = fs.realpathSync(path.resolve(root));
  const directory = fs.realpathSync(path.join(realRoot, jobId));
  if (!directory.startsWith(`${realRoot}${path.sep}`) || fs.lstatSync(directory).isSymbolicLink()) {
    throw new AudioQualityError("UNSAFE_PATH", "手動ジョブルート外は品質確認できません。");
  }
  const jobFile = path.join(directory, "job.json");
  return { directory, jobFile, job: JSON.parse(fs.readFileSync(jobFile, "utf8")) };
}

function decodeMono(file, options = {}) {
  const ffmpeg = options.ffmpegPath || "ffmpeg";
  const result = spawnSync(ffmpeg, ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"], {
    encoding: null,
    maxBuffer: MAX_DECODE_BYTES,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length < 4) {
    throw new AudioQualityError("AUDIO_DECODE_FAILED", "品質確認用に音声を読み込めませんでした。", { retryable: true });
  }
  const samples = new Float32Array(Math.floor(result.stdout.length / 4));
  for (let index = 0; index < samples.length; index += 1) samples[index] = result.stdout.readFloatLE(index * 4);
  return samples;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function estimateF0(samples) {
  const frameSize = 640;
  const hop = 320;
  const pitches = [];
  const analysisLength = Math.min(samples.length, SAMPLE_RATE * 30);
  for (let start = 0; start + frameSize <= analysisLength; start += hop) {
    let energy = 0;
    for (let index = 0; index < frameSize; index += 1) energy += samples[start + index] ** 2;
    if (energy / frameSize < 0.00005) continue;
    let bestLag = 0;
    let bestCorrelation = 0;
    for (let lag = 50; lag <= 320; lag += 1) {
      let cross = 0; let leftEnergy = 0; let rightEnergy = 0;
      for (let index = lag; index < frameSize; index += 1) {
        const left = samples[start + index]; const right = samples[start + index - lag];
        cross += left * right; leftEnergy += left * left; rightEnergy += right * right;
      }
      const correlation = cross / Math.sqrt(leftEnergy * rightEnergy || 1);
      if (correlation > bestCorrelation) { bestCorrelation = correlation; bestLag = lag; }
    }
    if (bestLag && bestCorrelation >= 0.6) pitches.push(SAMPLE_RATE / bestLag);
  }
  return { median_hz: median(pitches), voiced_frames: pitches.length };
}

function analyzeAudioFile(file, options = {}) {
  const samples = decodeMono(file, options);
  let squareSum = 0; let peak = 0; let zeroCrossings = 0; let previous = samples[0] || 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Number(samples[index]);
    squareSum += value * value; peak = Math.max(peak, Math.abs(value));
    if ((previous < 0 && value >= 0) || (previous >= 0 && value < 0)) zeroCrossings += 1;
    previous = value;
  }
  const rms = Math.sqrt(squareSum / samples.length);
  const f0 = estimateF0(samples);
  return {
    duration_seconds: samples.length / SAMPLE_RATE,
    rms_dbfs: rms > 0 ? 20 * Math.log10(rms) : -120,
    peak_dbfs: peak > 0 ? 20 * Math.log10(peak) : -120,
    zero_crossing_rate: zeroCrossings / samples.length,
    f0_median_hz: f0.median_hz,
    f0_voiced_frames: f0.voiced_frames,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  };
}

function classifyMetrics(items) {
  const spokenItems = items.filter((item) => !item.intentional_silence);
  const baselines = {
    rms_dbfs: median(spokenItems.map((item) => item.metrics.rms_dbfs)),
    duration_per_char: median(spokenItems.map((item) => item.metrics.duration_seconds / Math.max(1, item.speech_characters))),
    f0_median_hz: median(spokenItems.map((item) => item.metrics.f0_median_hz)),
  };
  const anomalies = [];
  for (const item of items) {
    if (item.intentional_silence) continue;
    const reasons = [];
    const durationPerChar = item.metrics.duration_seconds / Math.max(1, item.speech_characters);
    if (item.metrics.duration_seconds < 0.3) reasons.push("DURATION_TOO_SHORT");
    if (item.metrics.rms_dbfs < -45 || item.metrics.peak_dbfs < -30) reasons.push("VERY_LOW_LEVEL");
    if (item.metrics.peak_dbfs > -0.05) reasons.push("POSSIBLE_CLIPPING");
    if (spokenItems.length >= 3 && baselines.rms_dbfs !== null && Math.abs(item.metrics.rms_dbfs - baselines.rms_dbfs) > 14) reasons.push("LEVEL_OUTLIER");
    if (spokenItems.length >= 3 && baselines.duration_per_char !== null
      && (durationPerChar > baselines.duration_per_char * 3.5 || durationPerChar < baselines.duration_per_char / 3.5)) reasons.push("DURATION_OUTLIER");
    const f0Ratio = item.metrics.f0_median_hz && baselines.f0_median_hz
      ? Math.max(item.metrics.f0_median_hz / baselines.f0_median_hz, baselines.f0_median_hz / item.metrics.f0_median_hz)
      : null;
    if (reasons.length) anomalies.push({ ...(item.identity || { segment_id: item.segment_id }), reasons, metrics: { ...item.metrics, duration_per_char: durationPerChar, f0_ratio_to_median: f0Ratio } });
  }
  return { baselines, anomalies };
}

function checkManualAudioQuality(jobId, options = {}) {
  const resolved = resolveJob(options.root, jobId);
  let job = resolved.job;
  const blockMode = hasAudioBlocks(job);
  if (job.version !== 2 || job.mode !== "manual" || job.status !== "audio_ready"
    || (!blockMode && (!Array.isArray(job.segments) || !job.segments.length
      || job.segments.some((segment) => !SEGMENT_ID_PATTERN.test(segment.id) || !segment.audio || segment.audio.status !== "generated")))
    || (blockMode && job.audio_blocks.some((block) => block.status !== "completed"))) {
    throw new AudioQualityError("INVALID_JOB_STATE", "全segment音声の生成完了後だけ品質確認できます。");
  }
  const startedAt = new Date().toISOString();
  job.status = "audio_quality_checking"; job.current_stage = "audio_quality_checking"; job.updated_at = startedAt;
  job.history = [...(job.history || []), { at: startedAt, stage: "audio_quality_checking", message: `${blockMode ? "block" : "segment"}音声の品質確認を開始` }];
  atomicWriteJson(resolved.jobFile, job);
  try {
    const analyze = options.analyzeFile || ((file) => analyzeAudioFile(file, options));
    const units = blockMode ? job.audio_blocks : job.segments;
    const items = units.map((unit) => {
      const prepared = normalizeSpeechForIrodori(blockMode ? unit.text : unit.speech_text);
      const spoken = applyPronunciationDictionary(prepared.text, loadPronunciationDictionary(options.pronunciationDictionaryPath));
      return {
        ...(blockMode
          ? { audio_block_id: unit.id, segment_ids: unit.segment_ids, identity: { audio_block_id: unit.id, segment_ids: unit.segment_ids } }
          : { segment_id: unit.id }),
        intentional_silence: prepared.intentional_silence,
        speech_characters: Array.from(spoken.text.replace(/\s/gu, "")).length,
        metrics: analyze(path.join(resolved.directory, "audio", `${unit.id}.wav`), unit),
      };
    });
    const result = classifyMetrics(items);
    const checkedAt = new Date().toISOString();
    job = JSON.parse(fs.readFileSync(resolved.jobFile, "utf8"));
    job.audio_quality = {
      version: blockMode ? 2 : 1,
      unit: blockMode ? "audio_block" : "segment",
      status: result.anomalies.length ? "attention" : "passed",
      checked_at: checkedAt,
      f0_is_diagnostic_alone: false,
      baselines: result.baselines,
      [blockMode ? "audio_blocks" : "segments"]: items,
      anomalies: result.anomalies,
      regeneration_count: Number(job.audio_quality && job.audio_quality.regeneration_count
        || job.regeneration && job.regeneration.audio_quality_regeneration_count || 0),
      max_regenerations: 2,
    };
    if (result.anomalies.length) {
      job.review = job.review || { required: false, reasons: [] };
      job.review.required = true;
      job.review.reasons = [...new Set([...(job.review.reasons || []), "AUDIO_QUALITY_ATTENTION"] )];
    }
    job.status = "audio_ready"; job.current_stage = "audio_ready"; job.updated_at = checkedAt;
    job.history.push({ at: checkedAt, stage: "audio_ready", message: result.anomalies.length ? `音声品質確認: ${result.anomalies.length}件を要確認` : "音声品質確認: 問題候補なし" });
    atomicWriteJson(resolved.jobFile, job);
    return { job, anomalies: result.anomalies };
  } catch (error) {
    job = JSON.parse(fs.readFileSync(resolved.jobFile, "utf8"));
    const failedAt = new Date().toISOString();
    job.status = "audio_ready"; job.current_stage = "audio_ready"; job.updated_at = failedAt;
    job.error = { stage: "audio_quality_checking", code: error.code || "AUDIO_QUALITY_FAILED", message: "音声品質を確認できませんでした。", retryable: error.retryable === true, segment_id: null };
    job.history.push({ at: failedAt, stage: "audio_quality_checking", message: "音声品質確認に失敗" });
    atomicWriteJson(resolved.jobFile, job);
    throw error;
  }
}

module.exports = { AudioQualityError, analyzeAudioFile, checkManualAudioQuality, classifyMetrics };
