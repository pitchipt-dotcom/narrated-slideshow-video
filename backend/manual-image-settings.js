"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { applyImageTiming } = require("./manual-image-timing");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const IMAGE_ID_PATTERN = /^image_[0-9]{3,}$/;
const EDITABLE_STATES = new Set(["queued", "segmenting", "segments_ready", "waiting_for_tts_service", "audio_generating", "audio_ready", "subtitle_generating", "subtitle_ready", "image_planning", "images_ready"]);

class ImageSettingsError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ImageSettingsError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function resolveJobFile(root, jobId) {
  if (!root) throw new ImageSettingsError("ROOT_NOT_CONFIGURED", "手動ジョブ保存先が設定されていません。", 503);
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new ImageSettingsError("INVALID_JOB_ID", "ジョブIDが不正です。");
  const realRoot = fs.realpathSync(path.resolve(root));
  const directory = fs.realpathSync(path.join(realRoot, jobId));
  if (!directory.startsWith(`${realRoot}${path.sep}`)) throw new ImageSettingsError("UNSAFE_PATH", "手動ジョブルート外は更新できません。");
  const file = path.join(directory, "job.json");
  if (fs.lstatSync(file).isSymbolicLink()) throw new ImageSettingsError("UNSAFE_PATH", "シンボリックリンクのジョブは更新できません。");
  return file;
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

function readJob(root, jobId) {
  const file = resolveJobFile(root, jobId);
  const job = JSON.parse(fs.readFileSync(file, "utf8"));
  if (job.version !== 2 || job.mode !== "manual" || job.job_id !== jobId) throw new ImageSettingsError("INVALID_MANUAL_JOB", "version 2手動ジョブだけを編集できます。");
  return { file, job };
}

function imageSettingsDto(job) {
  return {
    job_id: job.job_id,
    status: job.status,
    segments: (job.segments || []).map((segment) => ({ id: segment.id, order: segment.order, label: String(segment.subtitle_text || "").slice(0, 60) })),
    images: [...job.images].sort((left, right) => left.order - right.order).map((image) => ({
      image_id: image.id,
      source_image_id: image.id,
      order: image.order,
      label: image.source === "library" ? `ライブラリ: ${image.library_asset_id || image.original_filename}` : `アップロード: ${image.original_filename}`,
      source: image.source,
      requested_duration_seconds: image.requested_duration_seconds,
      segment_ids: [...(image.segment_ids || [])],
    })),
  };
}

function getManualImageSettings(jobId, options = {}) {
  const { job } = readJob(options.root, jobId);
  return imageSettingsDto(job);
}

function normalizeRequestedItems(job, requested) {
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 20) throw new ImageSettingsError("INVALID_IMAGE_COUNT", "画像設定は1〜20件にしてください。");
  const originals = new Map(job.images.map((image) => [image.id, image]));
  const knownSegments = new Set((job.segments || []).map((segment) => segment.id));
  const usedIds = new Set();
  let nextNumber = Math.max(0, ...job.images.map((image) => Number(String(image.id).slice(6)) || 0)) + 1;
  const items = requested.map((item, index) => {
    const sourceId = String(item && item.source_image_id || "");
    if (!IMAGE_ID_PATTERN.test(sourceId) || !originals.has(sourceId)) throw new ImageSettingsError("UNKNOWN_SOURCE_IMAGE", "複製元画像が見つかりません。");
    const source = originals.get(sourceId);
    let id = sourceId;
    if (usedIds.has(id)) {
      do { id = `image_${String(nextNumber++).padStart(3, "0")}`; } while (usedIds.has(id) || originals.has(id));
    }
    usedIds.add(id);
    const rawDuration = item.requested_duration_seconds;
    const duration = rawDuration === null || rawDuration === undefined || rawDuration === "" ? null : Number(rawDuration);
    if (duration !== null && (!Number.isFinite(duration) || duration <= 0 || duration > 86400)) throw new ImageSettingsError("INVALID_IMAGE_DURATION", "表示時間は正の秒数で指定してください。");
    const segmentIds = Array.isArray(item.segment_ids) ? [...new Set(item.segment_ids.map(String))] : [];
    if (segmentIds.some((segmentId) => !/^seg_[0-9]{3,}$/.test(segmentId) || !knownSegments.has(segmentId))) {
      throw new ImageSettingsError("UNKNOWN_SEGMENT", "存在しない字幕segmentが指定されています。");
    }
    return {
      ...structuredClone(source), id, order: index + 1, segment_ids: segmentIds,
      requested_duration_seconds: duration, start_seconds: null, end_seconds: null, duration_seconds: null,
    };
  });
  const hasDuration = items.some((image) => image.requested_duration_seconds !== null);
  if (hasDuration && items.some((image) => image.requested_duration_seconds === null)) throw new ImageSettingsError("PARTIAL_IMAGE_DURATIONS", "表示時間は全画像へ指定するか、すべて空にしてください。");
  const hasSegments = items.some((image) => image.segment_ids.length > 0);
  if (hasSegments) {
    if (!knownSegments.size || items.some((image) => image.segment_ids.length === 0)) throw new ImageSettingsError("PARTIAL_SEGMENT_ASSIGNMENT", "対応segmentは全画像へ指定してください。");
    const assigned = items.flatMap((image) => image.segment_ids);
    if (assigned.length !== knownSegments.size || new Set(assigned).size !== assigned.length || assigned.some((id) => !knownSegments.has(id))) {
      throw new ImageSettingsError("INVALID_SEGMENT_ASSIGNMENT", "全segmentを重複なく1回だけ割り当ててください。");
    }
  }
  return items;
}

function updateManualImageSettings(jobId, requested, options = {}) {
  const { file, job: original } = readJob(options.root, jobId);
  if (!EDITABLE_STATES.has(original.status) || !EDITABLE_STATES.has(original.current_stage)) throw new ImageSettingsError("JOB_NOT_EDITABLE", "動画生成開始後または終了後の画像設定は変更できません。", 409);
  const updated = structuredClone(original);
  updated.images = normalizeRequestedItems(updated, requested);
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new ImageSettingsError("INVALID_TIME", "更新日時が不正です。");
  const canPlan = ["subtitle_ready", "image_planning", "images_ready"].includes(updated.status)
    && updated.segments.every((segment) => Number.isFinite(segment.timing && segment.timing.start_seconds) && Number.isFinite(segment.timing && segment.timing.end_seconds));
  let planMode = null;
  if (canPlan) {
    updated.status = "subtitle_ready";
    updated.current_stage = "subtitle_ready";
    const planned = applyImageTiming(updated);
    planMode = planned.mode;
    updated.status = "images_ready";
    updated.current_stage = "images_ready";
  } else {
    for (const segment of updated.segments || []) segment.image_id = null;
  }
  updated.updated_at = now.toISOString();
  updated.error = null;
  updated.history.push({ at: updated.updated_at, stage: updated.current_stage, message: `画像詳細設定を保存${planMode ? `・再計算: ${planMode}` : ""}` });
  const latest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (latest.updated_at !== original.updated_at) throw new ImageSettingsError("JOB_CHANGED", "画像設定中にジョブが変更されました。", 409);
  atomicWriteJson(file, updated);
  return { job: updated, settings: imageSettingsDto(updated), plan_mode: planMode };
}

module.exports = { ImageSettingsError, getManualImageSettings, updateManualImageSettings };
