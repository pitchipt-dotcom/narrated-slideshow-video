"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { formatSrtSeconds } = require("./common-video-processing");
const { probeDuration } = require("./manual-audio-assembly");
const { layoutTimedSegments, layoutTimedText } = require("./subtitle-layout");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const LOGICAL_ROOT_DEFAULT = "/data/slideshow/manual_jobs";
const MAX_CUE_CHARS_DEFAULT = 40;
const MAX_LINE_CHARS_DEFAULT = 20;
const MIN_CUE_MS_DEFAULT = 1200;

class SubtitleGenerationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "SubtitleGenerationError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.cause = options.cause;
  }
}

function codePoints(text) {
  return Array.from(text);
}

function normalizedSubtitle(text) {
  if (typeof text !== "string" || !text.trim()) throw new SubtitleGenerationError("EMPTY_SUBTITLE", "空の字幕は生成できません。");
  return text.trim().replace(/\s+/gu, " ");
}

function preferredBreak(chars, limit) {
  const punctuation = /[。！？!?、，,；;：:]/u;
  const minimum = Math.max(1, Math.floor(limit * 0.5));
  for (let index = Math.min(limit, chars.length) - 1; index >= minimum; index -= 1) {
    if (punctuation.test(chars[index])) return index + 1;
  }
  for (let index = Math.min(limit, chars.length) - 1; index >= minimum; index -= 1) {
    if (chars[index] === " ") return index + 1;
  }
  return Math.min(limit, chars.length);
}

function splitByLimit(text, limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new SubtitleGenerationError("INVALID_SUBTITLE_LIMIT", "字幕文字数制限が不正です。");
  const remaining = codePoints(normalizedSubtitle(text));
  const parts = [];
  while (remaining.length > limit) {
    const cut = preferredBreak(remaining, limit);
    parts.push(remaining.splice(0, cut).join("").trim());
    while (remaining[0] === " ") remaining.shift();
  }
  if (remaining.length) parts.push(remaining.join("").trim());
  if (parts.some((part) => !part)) throw new SubtitleGenerationError("EMPTY_SUBTITLE", "空の字幕区間が生成されました。");
  return parts;
}

function wrapCue(text, lineLimit = MAX_LINE_CHARS_DEFAULT) {
  const chars = codePoints(normalizedSubtitle(text));
  if (chars.length <= lineLimit) return chars.join("");
  if (chars.length > lineLimit * 2) throw new SubtitleGenerationError("SUBTITLE_LINE_OVERFLOW", "字幕を2行以内に収められません。");
  const punctuation = /[。！？!?、，,；;：:]/u;
  const minimum = chars.length - lineLimit;
  let cut = lineLimit;
  for (let index = lineLimit - 1; index >= minimum; index -= 1) {
    if (punctuation.test(chars[index])) { cut = index + 1; break; }
  }
  const first = chars.slice(0, cut).join("").trimEnd();
  const second = chars.slice(cut).join("").trimStart();
  if (!first || !second || codePoints(first).length > lineLimit || codePoints(second).length > lineLimit) {
    throw new SubtitleGenerationError("SUBTITLE_LINE_OVERFLOW", "字幕を2行以内に収められません。");
  }
  return `${first}\n${second}`;
}

function formatSrtTime(milliseconds) {
  if (!Number.isInteger(milliseconds) || milliseconds < 0) throw new SubtitleGenerationError("INVALID_SUBTITLE_TIME", "字幕時刻が不正です。");
  return formatSrtSeconds(milliseconds / 1000);
}

function cuesForSegment(segment, options = {}) {
  const maxCueChars = options.maxCueChars || MAX_CUE_CHARS_DEFAULT;
  const maxLineChars = options.maxLineChars || MAX_LINE_CHARS_DEFAULT;
  if (!Number.isInteger(maxCueChars) || !Number.isInteger(maxLineChars)
    || maxCueChars < 2 || maxLineChars < 1 || maxLineChars * 2 < maxCueChars) {
    throw new SubtitleGenerationError("INVALID_SUBTITLE_LIMIT", "字幕の画面・行文字数制限が不正です。");
  }
  const startMs = Math.round(Number(segment.timing.start_seconds) * 1000);
  const endMs = Math.round(Number(segment.timing.end_seconds) * 1000);
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < 0 || endMs <= startMs) {
    throw new SubtitleGenerationError("INVALID_SEGMENT_TIMING", `${segment.id}の字幕時刻が不正です。`);
  }
  try {
    return layoutTimedText(segment.subtitle_text, startMs, endMs, {
      maxCueChars, maxLineChars, minCueMs: options.minCueMs || MIN_CUE_MS_DEFAULT,
    }).map((cue) => ({ ...cue, segment_id: segment.id }));
  } catch (error) {
    throw new SubtitleGenerationError(error.code || "SUBTITLE_LAYOUT_FAILED", `${segment.id}: ${error.message}`, { cause: error });
  }
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o660 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; }
    throw error;
  }
}

function resolveJob(root, jobId) {
  if (!root) throw new SubtitleGenerationError("ROOT_NOT_CONFIGURED", "手動ジョブ保存先が設定されていません。");
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new SubtitleGenerationError("INVALID_JOB_ID", "ジョブIDが不正です。");
  const realRoot = fs.realpathSync(path.resolve(root));
  const jobDirectory = fs.realpathSync(path.join(realRoot, jobId));
  if (!jobDirectory.startsWith(`${realRoot}${path.sep}`)) throw new SubtitleGenerationError("UNSAFE_PATH", "手動ジョブルート外のジョブは処理できません。");
  const jobFile = path.join(jobDirectory, "job.json");
  const audioDirectory = fs.realpathSync(path.join(jobDirectory, "audio"));
  const subtitleDirectory = fs.realpathSync(path.join(jobDirectory, "subtitles"));
  for (const target of [jobFile, audioDirectory, subtitleDirectory]) {
    if (fs.lstatSync(target).isSymbolicLink()) throw new SubtitleGenerationError("UNSAFE_PATH", "シンボリックリンクは字幕生成に使用できません。");
  }
  return { jobFile, audioDirectory, subtitleDirectory };
}

function timestamp(options) {
  const now = typeof options.now === "function" ? options.now() : (options.now instanceof Date ? options.now : new Date());
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new SubtitleGenerationError("INVALID_TIME", "更新日時が不正です。");
  return now.toISOString();
}

function generateManualSubtitles(jobId, options = {}) {
  const { jobFile, audioDirectory, subtitleDirectory } = resolveJob(options.root, jobId);
  const logicalRoot = String(options.logicalRoot || LOGICAL_ROOT_DEFAULT).replace(/\/+$/, "");
  const subtitleLogicalPath = path.posix.join(logicalRoot, jobId, "subtitles", "final.srt");
  const subtitleFile = path.join(subtitleDirectory, "final.srt");
  let job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  if (job.artifacts && job.artifacts.subtitle_file === subtitleLogicalPath && fs.existsSync(subtitleFile)) {
    return { job, subtitle_path: subtitleLogicalPath, cue_count: (fs.readFileSync(subtitleFile, "utf8").match(/--> /gu) || []).length, reused: true };
  }
  if (fs.existsSync(subtitleFile)) throw new SubtitleGenerationError("OUTPUT_ALREADY_EXISTS", "未登録の字幕があるため上書きしません。");
  if (!job || job.version !== 2 || job.mode !== "manual" || job.job_id !== jobId) throw new SubtitleGenerationError("INVALID_MANUAL_JOB", "version 2の手動ジョブだけを処理できます。");
  if (job.status !== "audio_ready" || job.current_stage !== "audio_ready") throw new SubtitleGenerationError("INVALID_JOB_STATE", "音声時間の確定後にだけ字幕を生成できます。");
  if (!Array.isArray(job.segments) || job.segments.length === 0) throw new SubtitleGenerationError("INVALID_SEGMENTS", "字幕segmentがありません。");
  const audioLogicalPath = path.posix.join(logicalRoot, jobId, "audio", "assembled.wav");
  const audioFile = path.join(audioDirectory, "assembled.wav");
  if (!job.artifacts || job.artifacts.audio_file !== audioLogicalPath || !fs.existsSync(audioFile)) throw new SubtitleGenerationError("AUDIO_FILE_MISSING", "連結音声がありません。");
  const audioDurationMs = Math.round(probeDuration(audioFile) * 1000);

  const ordered = [...job.segments].sort((left, right) => left.order - right.order);
  let previousEnd = 0;
  const segmentInputs = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const segment = ordered[index];
    if (segment.order !== index + 1 || !segment.timing) throw new SubtitleGenerationError("INVALID_SEGMENT_ORDER", "字幕segment順が不正です。");
    const segmentStart = Math.round(Number(segment.timing.start_seconds) * 1000);
    const segmentEnd = Math.round(Number(segment.timing.end_seconds) * 1000);
    if (segmentStart < previousEnd) throw new SubtitleGenerationError("SUBTITLE_OVERLAP", `${segment.id}の字幕時間が重なっています。`);
    if (segmentEnd > audioDurationMs) throw new SubtitleGenerationError("SUBTITLE_EXCEEDS_AUDIO", `${segment.id}の字幕終了が音声尺を超えています。`);
    segmentInputs.push({ id: segment.id, text: segment.subtitle_text, start_ms: segmentStart, end_ms: segmentEnd });
    previousEnd = segmentEnd;
  }
  let layout;
  try {
    layout = layoutTimedSegments(segmentInputs, {
      maxCueChars: options.maxCueChars || MAX_CUE_CHARS_DEFAULT,
      maxLineChars: options.maxLineChars || MAX_LINE_CHARS_DEFAULT,
      minCueMs: options.minCueMs || MIN_CUE_MS_DEFAULT,
    });
  } catch (error) {
    throw new SubtitleGenerationError(error.code || "SUBTITLE_LAYOUT_FAILED", error.message, { cause: error });
  }
  const { cues, adjustments } = layout;
  if (!cues.length || cues[cues.length - 1].end_ms > audioDurationMs) throw new SubtitleGenerationError("SUBTITLE_EXCEEDS_AUDIO", "最終字幕終了が音声尺を超えています。");

  const content = `${cues.map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start_ms)} --> ${formatSrtTime(cue.end_ms)}\n${cue.text}`).join("\n\n")}\n`;
  const reflowFile = path.join(subtitleDirectory, "reflow-log.json");
  const reflowContent = `${JSON.stringify({
    generated_at: timestamp(options),
    minimum_cue_ms: options.minCueMs || MIN_CUE_MS_DEFAULT,
    adjustments,
  }, null, 2)}\n`;
  const expectedUpdatedAt = job.updated_at;
  const lockFile = path.join(subtitleDirectory, ".subtitle.lock");
  let lock;
  try { lock = fs.openSync(lockFile, "wx", 0o660); } catch (error) {
    if (error.code === "EEXIST") throw new SubtitleGenerationError("SUBTITLE_BUSY", "このジョブの字幕生成は実行中です。", { retryable: true });
    throw error;
  }
  let ownsSubtitle = false;
  let ownsReflowLog = false;
  try {
    fs.writeFileSync(subtitleFile, content, { encoding: "utf8", flag: "wx", mode: 0o660 });
    ownsSubtitle = true;
    fs.writeFileSync(reflowFile, reflowContent, { encoding: "utf8", flag: "wx", mode: 0o660 });
    ownsReflowLog = true;
    job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    if (job.updated_at !== expectedUpdatedAt || job.status !== "audio_ready" || job.current_stage !== "audio_ready") {
      throw new SubtitleGenerationError("JOB_CHANGED", "字幕生成中にジョブ状態が変更されました。", { retryable: true });
    }
    job.status = "subtitle_ready";
    job.current_stage = "subtitle_ready";
    job.updated_at = timestamp(options);
    job.artifacts.subtitle_file = subtitleLogicalPath;
    job.error = null;
    job.history.push({ at: job.updated_at, stage: "subtitle_generating", message: "音声時間から字幕を生成" });
    for (const adjustment of adjustments) {
      const before = adjustment.before.map((cue) => `${cue.text}[${cue.start_ms}-${cue.end_ms}]`).join(" / ");
      const after = adjustment.after.map((cue) => `${cue.text}[${cue.start_ms}-${cue.end_ms}]`).join(" / ");
      job.history.push({
        at: job.updated_at,
        stage: "subtitle_generating",
        message: `${adjustment.segment_id} 字幕時間を自動再調整: 前 ${before} / 後 ${after}`.slice(0, 1000),
      });
    }
    job.history.push({ at: job.updated_at, stage: "subtitle_ready", message: `${cues.length}件の字幕を保存` });
    atomicWriteJson(jobFile, job);
    return { job, subtitle_path: subtitleLogicalPath, cue_count: cues.length, audio_duration_seconds: audioDurationMs / 1000, reused: false };
  } catch (error) {
    if (ownsSubtitle) {
      try { fs.unlinkSync(subtitleFile); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; }
    }
    if (ownsReflowLog) {
      try { fs.unlinkSync(reflowFile); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; }
    }
    throw error;
  } finally {
    try { fs.closeSync(lock); } finally { try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  }
}

module.exports = {
  MAX_CUE_CHARS_DEFAULT,
  MAX_LINE_CHARS_DEFAULT,
  MIN_CUE_MS_DEFAULT,
  SubtitleGenerationError,
  cuesForSegment,
  formatSrtTime,
  generateManualSubtitles,
  splitByLimit,
  wrapCue,
};
