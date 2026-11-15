"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { downloadFilenameForTitle } = require("./video-filename");
const { stallStatus } = require("./pipeline-stall-status");
const { cancellationRequested } = require("./manual-job-cancellation");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const VIDEO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.mp4$/;
const STATUS_LABELS = {
  queued: "受付済み", accepted: "受付済み", validating: "台本を確認中", segmenting: "台本を確認中", segments_ready: "セグメント準備完了",
  waiting_for_tts_service: "Irodori音声サービス待ち", audio_generation: "Irodoriで音声生成中", audio_generating: "Irodoriで音声生成中", audio_ready: "音声生成完了", audio_assembled: "音声結合完了",
  audio_quality_checking: "音声品質チェック中",
  subtitle_generating: "字幕生成中", subtitle_ready: "字幕生成完了", image_planning: "画像準備中", images_ready: "画像準備完了",
  waiting_for_video_service: "動画サービス待ち", video_generation: "FFmpegで動画生成中", video_generating: "FFmpegで動画生成中", video_ready: "動画生成完了",
  archived: "保存完了", completed: "保存完了", failed: "エラーで停止", needs_input_correction: "台本の修正が必要", manual_review_required: "確認が必要", cancelled: "取消済み",
};
const ERROR_STAGE_LABELS = {
  audio_quality_checking: "音声品質チェック",
  audio_ready: "音声時間取得・連結",
  subtitle_generating: "字幕生成",
  image_planning: "画像準備",
  video_generating: "FFmpeg動画生成",
  video_ready: "成果物保存",
};

class JobStatusError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = "JobStatusError"; this.code = code; this.statusCode = statusCode; }
}

function rootPath(root) {
  if (!root) throw new JobStatusError("ROOT_NOT_CONFIGURED", "手動ジョブ保存先が設定されていません。", 503);
  return fs.realpathSync(path.resolve(root));
}

function readJob(root, jobId) {
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new JobStatusError("INVALID_JOB_ID", "ジョブIDが不正です。");
  const realRoot = rootPath(root);
  let directory;
  try { directory = fs.realpathSync(path.join(realRoot, jobId)); } catch { throw new JobStatusError("JOB_NOT_FOUND", "手動ジョブが見つかりません。", 404); }
  if (!directory.startsWith(`${realRoot}${path.sep}`)) throw new JobStatusError("UNSAFE_PATH", "手動ジョブルート外は参照できません。");
  const job = JSON.parse(fs.readFileSync(path.join(directory, "job.json"), "utf8"));
  if (job.version !== 2 || job.mode !== "manual" || job.job_id !== jobId) throw new JobStatusError("INVALID_MANUAL_JOB", "手動ジョブを確認できません。", 500);
  return { directory, job };
}

function safeError(job) {
  const message = job.error && typeof job.error.message === "string" ? job.error.message : null;
  return message ? message.replace(/[\r\n]+/gu, " ").slice(0, 240) : null;
}

function segmentProgress(job) {
  if (Array.isArray(job.audio_blocks) && job.audio_blocks.length) {
    const completed = job.audio_blocks.filter((block) => block.status === "completed").length;
    const active = job.audio_blocks.find((block) => block.status === "generating")
      || job.audio_blocks.find((block) => ["pending", "failed", "quality_failed"].includes(block.status));
    return {
      current: active ? active.audio_block_index + 1 : completed,
      total: job.audio_blocks.length,
      unit: "block",
      subtitle_total: Array.isArray(job.segments) ? job.segments.length : 0,
      subtitle_range: active && active.subtitle_segment_indexes.length
        ? [active.subtitle_segment_indexes[0] + 1, active.subtitle_segment_indexes.at(-1) + 1]
        : null,
    };
  }
  if (!Array.isArray(job.segments) || job.segments.length === 0) return null;
  const generated = job.segments.filter((segment) => segment.audio && segment.audio.status === "generated").length;
  const activeIndex = job.segments.findIndex((segment) => segment.audio && segment.audio.status === "generating");
  return {
    current: activeIndex >= 0 ? activeIndex + 1 : generated,
    total: job.segments.length,
  };
}

function errorGuidance(job) {
  const code = job.error && job.error.code;
  if (code === "SEGMENT_COUNT_MISMATCH") return "字幕台本と読み台本の改行・空行・区切り行を同じ構造に揃えて、改めて登録してください。";
  if (code === "DELIMITER_MISMATCH") return "===SEGMENT=== の区切り行を両方の台本で同じ位置に入れてください。";
  return null;
}

const TTS_WAIT_LABELS = {
  host_busy: "GPUコーディネーターがGPU使用中",
  host_unknown: "GPUコーディネーターの状態を確認できません",
  gpu_busy: "GPU使用中",
  gpu_unknown: "GPUの状態を確認できません",
  start_failed: "起動失敗・再確認待ち",
  start_timeout: "起動中",
};

function ttsWait(job) {
  if (job.status !== "waiting_for_tts_service" || !job.tts_wait || typeof job.tts_wait.reason !== "string") return null;
  return job.tts_wait;
}

function stageLabel(job, stage) {
  const wait = stage === "waiting_for_tts_service" ? ttsWait(job) : null;
  if (wait) return `${STATUS_LABELS[stage]}（${TTS_WAIT_LABELS[wait.reason] || "起動待ち"}）`;
  if (stage === "audio_ready" && job.artifacts && job.artifacts.audio_file) return "音声結合完了";
  return STATUS_LABELS[stage] || "処理中";
}

function retryStateLabel(job) {
  if (job.error && job.error.retryable === false && ["SEGMENT_COUNT_MISMATCH", "DELIMITER_MISMATCH"].includes(job.error.code)) return "台本の修正が必要（自動再試行しません）";
  if (job.error && job.error.retryable === true) return "自動再試行待ち";
  if (job.status === "failed") return "自動再試行を停止";
  if (["video_ready", "completed", "archived", "cancelled", "manual_review_required"].includes(job.status)) return null;
  if (ttsWait(job)) return "待機中（GPUが空きしだい自動で再開）";
  return "処理中";
}

function nextStageLabel(job) {
  if (job.archive && ["local_only", "nas_saved"].includes(job.archive.status)) return null;
  if (job.status === "failed") {
    if (job.error && job.error.retryable === true) return "自動再試行";
    if (job.error && ["SEGMENT_COUNT_MISMATCH", "DELIMITER_MISMATCH"].includes(job.error.code)) return "台本を修正して新しく登録";
    return "管理者がエラー内容を確認";
  }
  const stage = job.current_stage || job.status;
  if (["queued", "accepted", "validating", "segmenting"].includes(stage)) return "セグメント準備 → Irodori音声生成";
  if (["segments_ready", "waiting_for_tts_service", "audio_generation", "audio_generating"].includes(stage)) return "音声品質確認 → 音声結合 → 字幕生成 → FFmpeg動画生成";
  if (stage === "audio_quality_checking") return "音声結合 → 字幕生成 → FFmpeg動画生成";
  if (["audio_ready", "audio_assembled"].includes(stage)) return "字幕生成 → 画像準備 → FFmpeg動画生成";
  if (["subtitle_generating", "subtitle_ready"].includes(stage)) return "画像準備 → FFmpeg動画生成";
  if (["image_planning", "images_ready", "waiting_for_video_service"].includes(stage)) return "FFmpeg動画生成 → 保存";
  if (["video_generation", "video_generating"].includes(stage)) return "動画生成完了 → 保存";
  if (stage === "video_ready") return "保存";
  return null;
}

function statusDto(directory, job) {
  const filename = job.output && job.output.filename;
  const videoFile = filename && VIDEO_NAME_PATTERN.test(filename) ? path.join(directory, "video", filename) : null;
  const videoReady = ["video_ready", "completed"].includes(job.status) && videoFile && fs.existsSync(videoFile) && fs.lstatSync(videoFile).isFile();
  const quality = job.audio_quality && typeof job.audio_quality === "object" ? job.audio_quality : null;
  const anomalyIds = quality && Array.isArray(quality.anomalies)
    ? quality.anomalies.map((item) => item && item.segment_id).filter((id) => /^seg_[0-9]{3,}$/.test(String(id)))
    : [];
  const anomalyBlockIds = quality && Array.isArray(quality.anomalies)
    ? quality.anomalies.map((item) => item && item.audio_block_id).filter((id) => /^block_[0-9]{3,}$/.test(String(id)))
    : [];
  const regenerationCount = quality ? Number(quality.regeneration_count || 0) : Number(job.regeneration && job.regeneration.audio_quality_regeneration_count || 0);
  const regenerationLimit = quality ? Number(quality.max_regenerations || 2) : 2;
  const stall = stallStatus(job);
  return {
    job_id: job.job_id,
    mode: "manual",
    mode_label: "手動モード",
    title: String(job.input && job.input.title || (job.output && job.output.filename) || job.job_id).slice(0, 220),
    status: job.status,
    status_label: ttsWait(job) ? stageLabel(job, job.status) : (STATUS_LABELS[job.status] || "処理中"),
    tts_wait_reason: ttsWait(job) ? job.tts_wait.reason : null,
    tts_wait_message: ttsWait(job) && typeof job.tts_wait.message === "string" ? job.tts_wait.message.slice(0, 240) : null,
    current_stage: job.current_stage,
    current_stage_label: stageLabel(job, job.current_stage),
    created_at: job.created_at,
    updated_at: job.updated_at,
    ...stall,
    segment_progress: segmentProgress(job),
    voice_seed: job.voice_generation && Number.isInteger(job.voice_generation.seed) ? job.voice_generation.seed : null,
    voice_conditioning_label: job.voice_generation ? (job.voice_generation.reference_audio_used ? "caption＋参照音声" : "caption-only（参照音声なし）") : null,
    audio_quality_status: quality ? quality.status : null,
    audio_quality_label: quality ? (quality.status === "passed" ? "品質チェック完了（問題候補なし）" : `品質チェック完了（要確認${anomalyIds.length}件）`) : (job.current_stage === "audio_quality_checking" ? "音声品質チェック中" : null),
    audio_anomaly_segment_ids: anomalyIds,
    audio_anomaly_block_ids: anomalyBlockIds,
    audio_regeneration_count: regenerationCount,
    audio_regeneration_limit: regenerationLimit,
    is_audio_partial_regeneration: Boolean(job.regeneration && ["anomalous_audio_segments", "anomalous_audio_blocks"].includes(job.regeneration.kind)),
    error_code: job.error && typeof job.error.code === "string" ? job.error.code : null,
    error_stage: job.error && typeof job.error.stage === "string" ? job.error.stage : null,
    error_stage_label: job.error && typeof job.error.stage === "string" ? (ERROR_STAGE_LABELS[job.error.stage] || stageLabel(job, job.error.stage)) : null,
    error_retryable: job.error && typeof job.error.retryable === "boolean" ? job.error.retryable : null,
    error_summary: safeError(job),
    error_guidance: errorGuidance(job),
    retry_state_label: retryStateLabel(job),
    next_stage_label: nextStageLabel(job),
    cancellation_requested: cancellationRequested(directory),
    can_cancel: !["video_ready", "completed", "cancelled", "manual_review_required"].includes(job.status),
    video_url: videoReady ? `/video/job/${encodeURIComponent(job.job_id)}/view` : null,
    can_regenerate: ["video_ready", "completed", "failed"].includes(job.status) && (!(anomalyIds.length || anomalyBlockIds.length) || regenerationCount < regenerationLimit),
    regenerate_action_label: anomalyBlockIds.length ? "異常候補の音声ブロックだけ再生成"
      : (anomalyIds.length ? "異常候補の音声だけ再生成" : "この素材で再生成"),
  };
}

function getManualJobStatus(root, jobId) {
  const { directory, job } = readJob(root, jobId);
  return statusDto(directory, job);
}

function listManualJobStatuses(root, options = {}) {
  const realRoot = rootPath(root);
  const limit = options.limit === undefined ? 20 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new JobStatusError("INVALID_LIMIT", "limitは1〜100で指定してください。");
  const jobs = [];
  for (const entry of fs.readdirSync(realRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
    try { const read = readJob(realRoot, entry.name); jobs.push(statusDto(read.directory, read.job)); } catch {}
  }
  jobs.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.job_id.localeCompare(left.job_id));
  let offset = 0;
  if (options.cursor) {
    if (!JOB_ID_PATTERN.test(String(options.cursor))) throw new JobStatusError("INVALID_CURSOR", "cursorが不正です。");
    const found = jobs.findIndex((job) => job.job_id === options.cursor);
    if (found < 0) throw new JobStatusError("CURSOR_NOT_FOUND", "cursorのジョブが見つかりません。");
    offset = found + 1;
  }
  const items = jobs.slice(offset, offset + limit);
  return { items, next_cursor: offset + items.length < jobs.length && items.length ? items.at(-1).job_id : null };
}

function resolveManualVideo(root, jobId) {
  const { directory, job } = readJob(root, jobId);
  if (!["video_ready", "completed"].includes(job.status)) throw new JobStatusError("VIDEO_NOT_READY", "完成動画はまだ利用できません。", 409);
  const filename = job.output && job.output.filename;
  if (!VIDEO_NAME_PATTERN.test(String(filename || "")) || !job.artifacts || !String(job.artifacts.video_file || "").endsWith(`/video/${filename}`)) {
    throw new JobStatusError("VIDEO_STATE_MISMATCH", "完成動画の保存状態が一致しません。", 500);
  }
  const videoDirectory = fs.realpathSync(path.join(directory, "video"));
  const file = fs.realpathSync(path.join(videoDirectory, filename));
  if (!file.startsWith(`${videoDirectory}${path.sep}`) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new JobStatusError("UNSAFE_VIDEO_PATH", "完成動画を安全に参照できません。", 500);
  return { file, filename, downloadFilename: downloadFilenameForTitle(job.input && job.input.title) };
}

module.exports = { JobStatusError, getManualJobStatus, listManualJobStatuses, resolveManualVideo };
