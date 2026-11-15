"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { attachAudioBlocks, audioBlockConfig } = require("./manual-audio-blocks");

const EXPLICIT_DELIMITER = "===SEGMENT===";
const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const DEFAULT_LONG_SUBTITLE_CHARS = 80;
const MAX_SUBTITLE_SEGMENT_CHARS = 1000;
const MAX_SPEECH_SEGMENT_CHARS = 2000;

class SegmentationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SegmentationError";
    this.code = code;
    this.details = details;
    this.retryable = false;
  }
}

function trimBoundaryWhitespace(value) {
  return String(value).replace(/^\s+|\s+$/gu, "");
}

function hasExplicitDelimiter(text) {
  return /^[\t ]*===SEGMENT===[\t ]*$/mu.test(text);
}

function ensureNonEmpty(parts, source) {
  if (parts.length === 0 || parts.some((part) => !part)) {
    throw new SegmentationError("EMPTY_SEGMENT", `${source}に空のセグメントがあります。`, { source });
  }
  return parts;
}

function splitExplicit(text, source) {
  const parts = text
    .split(/^[\t ]*===SEGMENT===[\t ]*$/mu)
    .map(trimBoundaryWhitespace);
  return { strategy: "explicit_delimiter", parts: ensureNonEmpty(parts, source) };
}

function splitBlocks(text) {
  const parts = text
    .split(/\r?\n(?:[\t ]*\r?\n)+/u)
    .map(trimBoundaryWhitespace);
  return parts.length > 1 ? parts : null;
}

function isSentenceEnd(character) {
  return character === "。" || character === "！" || character === "？" || character === "!" || character === "?";
}

function isSentenceCloser(character) {
  return character === "」" || character === "』" || character === "）" || character === ")" || character === "】" || character === "]" || character === "\"" || character === "'";
}

function splitSentences(text) {
  const parts = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (!isSentenceEnd(text[index])) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < text.length && isSentenceEnd(text[end])) end += 1;
    while (end < text.length && isSentenceCloser(text[end])) end += 1;
    const part = trimBoundaryWhitespace(text.slice(start, end));
    if (part) parts.push(part);
    start = end;
    index = end;
  }
  const tail = trimBoundaryWhitespace(text.slice(start));
  if (tail) parts.push(tail);
  return parts;
}

function splitAutomatic(text, source) {
  const blocks = splitBlocks(text);
  if (blocks) return { strategy: "blank_line_blocks", parts: ensureNonEmpty(blocks, source) };
  return { strategy: "sentence_punctuation", parts: ensureNonEmpty(splitSentences(text), source) };
}

function segmentScripts(subtitleText, speechText, options = {}) {
  if (typeof subtitleText !== "string" || !subtitleText.trim()) {
    throw new SegmentationError("INVALID_SUBTITLE_TEXT", "字幕表示用台本が空です。");
  }
  if (typeof speechText !== "string" || !speechText.trim()) {
    throw new SegmentationError("INVALID_SPEECH_TEXT", "読み上げ用台本が空です。");
  }

  const subtitleHasDelimiter = hasExplicitDelimiter(subtitleText);
  const speechHasDelimiter = hasExplicitDelimiter(speechText);
  if (subtitleHasDelimiter !== speechHasDelimiter) {
    throw new SegmentationError(
      "DELIMITER_MISMATCH",
      `明示区切り行「${EXPLICIT_DELIMITER}」は両方の台本で同じように使用してください。`,
      { subtitle_has_delimiter: subtitleHasDelimiter, speech_has_delimiter: speechHasDelimiter },
    );
  }

  const subtitle = subtitleHasDelimiter
    ? splitExplicit(subtitleText, "字幕表示用台本")
    : splitAutomatic(subtitleText, "字幕表示用台本");
  const speech = speechHasDelimiter
    ? splitExplicit(speechText, "読み上げ用台本")
    : splitAutomatic(speechText, "読み上げ用台本");

  if (subtitle.parts.length !== speech.parts.length) {
    throw new SegmentationError(
      "SEGMENT_COUNT_MISMATCH",
      "字幕表示用台本と読み上げ用台本のセグメント数が一致しません。",
      {
        subtitle_count: subtitle.parts.length,
        speech_count: speech.parts.length,
        subtitle_strategy: subtitle.strategy,
        speech_strategy: speech.strategy,
      },
    );
  }

  const longSubtitleChars = Number.isInteger(options.longSubtitleChars) && options.longSubtitleChars > 0
    ? options.longSubtitleChars
    : DEFAULT_LONG_SUBTITLE_CHARS;
  const warnings = [];
  const segments = subtitle.parts.map((subtitlePart, index) => {
    const number = String(index + 1).padStart(3, "0");
    const segmentId = `seg_${number}`;
    const speechPart = speech.parts[index];
    if (subtitlePart.length > MAX_SUBTITLE_SEGMENT_CHARS) {
      throw new SegmentationError("SUBTITLE_SEGMENT_TOO_LONG", "Schema上限を超える字幕セグメントがあります。", {
        segment_id: segmentId,
        length: subtitlePart.length,
        limit: MAX_SUBTITLE_SEGMENT_CHARS,
      });
    }
    if (speechPart.length > MAX_SPEECH_SEGMENT_CHARS) {
      throw new SegmentationError("SPEECH_SEGMENT_TOO_LONG", "Schema上限を超える読み上げセグメントがあります。", {
        segment_id: segmentId,
        length: speechPart.length,
        limit: MAX_SPEECH_SEGMENT_CHARS,
      });
    }
    if (subtitlePart.length > longSubtitleChars) {
      warnings.push({
        code: "LONG_SUBTITLE_SEGMENT",
        segment_id: segmentId,
        length: subtitlePart.length,
        recommended_max: longSubtitleChars,
      });
    }
    return {
      id: segmentId,
      order: index + 1,
      subtitle_text: subtitlePart,
      speech_text: speechPart,
      image_id: null,
      requested_image_duration_seconds: null,
      audio: { status: "pending", path: null, duration_seconds: null, error: null },
      timing: { start_seconds: null, end_seconds: null },
    };
  });

  return {
    segments,
    report: {
      segment_count: segments.length,
      subtitle_strategy: subtitle.strategy,
      speech_strategy: speech.strategy,
      explicit_delimiter: subtitleHasDelimiter ? EXPLICIT_DELIMITER : null,
      warnings,
    },
  };
}

function applySegmentationToJob(job, options = {}) {
  if (!job || job.version !== 2 || job.mode !== "manual") {
    throw new SegmentationError("INVALID_MANUAL_JOB", "version 2の手動ジョブだけを分割できます。");
  }
  if (job.status !== "queued" || job.current_stage !== "queued") {
    throw new SegmentationError("INVALID_JOB_STATE", "queued状態の手動ジョブだけを分割できます。", {
      status: job.status,
      current_stage: job.current_stage,
    });
  }
  if (!job.input || typeof job.input.subtitle_text !== "string" || typeof job.input.speech_text !== "string") {
    throw new SegmentationError("INVALID_JOB_INPUT", "ジョブに2種類の元台本がありません。");
  }
  if (Array.isArray(job.segments) && job.segments.length > 0) {
    throw new SegmentationError("ALREADY_SEGMENTED", "すでにセグメントが保存されています。");
  }

  const result = segmentScripts(job.input.subtitle_text, job.input.speech_text, options);
  const updated = structuredClone(job);
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new SegmentationError("INVALID_TIME", "更新日時が不正です。");
  const timestamp = now.toISOString();
  if (Date.parse(timestamp) < Date.parse(updated.created_at)) {
    throw new SegmentationError("INVALID_TIME", "更新日時を作成日時より前にはできません。");
  }
  updated.segments = result.segments;
  updated.audio_blocks = attachAudioBlocks(updated.segments, options.audioBlockConfig || audioBlockConfig(options.env || process.env));
  result.report.audio_block_count = updated.audio_blocks.length;
  result.report.audio_block_config = options.audioBlockConfig || audioBlockConfig(options.env || process.env);
  updated.status = "segments_ready";
  updated.current_stage = "segments_ready";
  updated.updated_at = timestamp;
  updated.history = [
    ...(updated.history || []),
    { at: timestamp, stage: "segmenting", message: "2種類の台本をセグメント分割" },
    { at: timestamp, stage: "segments_ready", message: `${result.segments.length}字幕セグメント・${updated.audio_blocks.length}音声ブロックを保存` },
  ];
  return { job: updated, report: result.report };
}

function resolveJobFile(root, jobId) {
  if (!root) throw new SegmentationError("ROOT_NOT_CONFIGURED", "手動ジョブ保存先が設定されていません。");
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new SegmentationError("INVALID_JOB_ID", "ジョブIDが不正です。");
  const realRoot = fs.realpathSync(path.resolve(root));
  const jobDirectory = fs.realpathSync(path.resolve(realRoot, jobId));
  if (!jobDirectory.startsWith(`${realRoot}${path.sep}`)) {
    throw new SegmentationError("UNSAFE_PATH", "手動ジョブルート外のジョブは更新できません。");
  }
  const file = path.join(jobDirectory, "job.json");
  if (fs.lstatSync(file).isSymbolicLink()) throw new SegmentationError("UNSAFE_PATH", "シンボリックリンクのジョブは更新できません。");
  return file;
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

function segmentAndSaveManualJob(jobId, options = {}) {
  const file = resolveJobFile(options.root, jobId);
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  if (original.job_id !== jobId) throw new SegmentationError("JOB_ID_MISMATCH", "ディレクトリとジョブ内容のIDが一致しません。");
  const result = applySegmentationToJob(original, options);
  atomicWriteJson(file, result.job);
  return result;
}

module.exports = {
  DEFAULT_LONG_SUBTITLE_CHARS,
  EXPLICIT_DELIMITER,
  SegmentationError,
  applySegmentationToJob,
  segmentAndSaveManualJob,
  segmentScripts,
};
