"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const EPSILON = 0.01;

class ImageTimingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ImageTimingError";
    this.code = code;
  }
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
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

function resolveJobFile(root, jobId) {
  if (!root) throw new ImageTimingError("ROOT_NOT_CONFIGURED", "手動ジョブ保存先が設定されていません。");
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new ImageTimingError("INVALID_JOB_ID", "ジョブIDが不正です。");
  const realRoot = fs.realpathSync(path.resolve(root));
  const jobDirectory = fs.realpathSync(path.join(realRoot, jobId));
  if (!jobDirectory.startsWith(`${realRoot}${path.sep}`)) throw new ImageTimingError("UNSAFE_PATH", "手動ジョブルート外のジョブは処理できません。");
  const file = path.join(jobDirectory, "job.json");
  if (fs.lstatSync(file).isSymbolicLink()) throw new ImageTimingError("UNSAFE_PATH", "シンボリックリンクのジョブは更新できません。");
  return file;
}

function orderedInputs(job) {
  if (!job || job.version !== 2 || job.mode !== "manual") throw new ImageTimingError("INVALID_MANUAL_JOB", "version 2の手動ジョブだけを処理できます。");
  if (job.status !== "subtitle_ready" || job.current_stage !== "subtitle_ready") throw new ImageTimingError("INVALID_JOB_STATE", "字幕生成完了後にだけ画像時間を計画できます。");
  if (!Array.isArray(job.images) || job.images.length < 1 || !Array.isArray(job.segments) || job.segments.length < 1) {
    throw new ImageTimingError("MISSING_INPUT", "画像とsegmentが必要です。");
  }
  const images = [...job.images].sort((left, right) => left.order - right.order);
  const segments = [...job.segments].sort((left, right) => left.order - right.order);
  const imageIds = new Set();
  const segmentIds = new Set();
  for (let index = 0; index < images.length; index += 1) {
    if (images[index].order !== index + 1 || imageIds.has(images[index].id)) throw new ImageTimingError("INVALID_IMAGE_ORDER", "画像順が連続または一意ではありません。");
    imageIds.add(images[index].id);
  }
  let previousEnd = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const start = Number(segment.timing && segment.timing.start_seconds);
    const end = Number(segment.timing && segment.timing.end_seconds);
    if (segment.order !== index + 1 || segmentIds.has(segment.id) || !Number.isFinite(start) || !Number.isFinite(end)
      || start < previousEnd - EPSILON || end <= start) throw new ImageTimingError("INVALID_SEGMENT_TIMING", "segment順または時間が不正です。");
    segmentIds.add(segment.id);
    previousEnd = end;
  }
  return { images, segments, totalDuration: previousEnd };
}

function overlappingSegments(segments, start, end) {
  const ids = segments.filter((segment) => Number(segment.timing.start_seconds) < end && Number(segment.timing.end_seconds) > start).map((segment) => segment.id);
  if (ids.length) return ids;
  const midpoint = (start + end) / 2;
  const closest = segments.reduce((best, segment) => {
    const segmentMidpoint = (Number(segment.timing.start_seconds) + Number(segment.timing.end_seconds)) / 2;
    const distance = Math.abs(segmentMidpoint - midpoint);
    return !best || distance < best.distance ? { id: segment.id, distance } : best;
  }, null);
  return [closest.id];
}

function planByDurations(images, segments, totalDuration) {
  if (images.some((image) => !Number.isFinite(Number(image.requested_duration_seconds)) || Number(image.requested_duration_seconds) <= 0)) {
    throw new ImageTimingError("PARTIAL_IMAGE_DURATIONS", "表示時間を指定する場合は全画像へ正の時間を指定してください。");
  }
  const requestedTotal = images.reduce((sum, image) => sum + Number(image.requested_duration_seconds), 0);
  if (Math.abs(requestedTotal - totalDuration) > EPSILON) throw new ImageTimingError("IMAGE_DURATION_MISMATCH", "画像表示時間の合計が音声時間と一致しません。");
  let cursor = 0;
  return images.map((image, index) => {
    const end = index === images.length - 1 ? totalDuration : cursor + Number(image.requested_duration_seconds);
    const planned = { image, start: cursor, end, segment_ids: overlappingSegments(segments, cursor, end) };
    cursor = end;
    return planned;
  });
}

function planByExplicitSegments(images, segments, totalDuration) {
  if (images.some((image) => !Array.isArray(image.segment_ids) || image.segment_ids.length === 0)) {
    throw new ImageTimingError("PARTIAL_SEGMENT_ASSIGNMENT", "segmentを指定する場合は全画像へ1件以上指定してください。");
  }
  const segmentOrder = new Map(segments.map((segment) => [segment.id, segment.order]));
  const seen = new Set();
  const groups = images.map((image) => {
    const orders = image.segment_ids.map((id) => {
      if (!segmentOrder.has(id) || seen.has(id)) throw new ImageTimingError("INVALID_SEGMENT_ASSIGNMENT", "画像のsegment指定が不明または重複しています。");
      seen.add(id);
      return segmentOrder.get(id);
    }).sort((left, right) => left - right);
    for (let index = 1; index < orders.length; index += 1) if (orders[index] !== orders[index - 1] + 1) throw new ImageTimingError("NONCONTIGUOUS_SEGMENTS", "1画像のsegment指定は連続させてください。");
    return { image, orders };
  });
  if (seen.size !== segments.length) throw new ImageTimingError("INCOMPLETE_SEGMENT_ASSIGNMENT", "全segmentを1画像へ割り当ててください。");
  for (let index = 1; index < groups.length; index += 1) {
    if (groups[index].orders[0] !== groups[index - 1].orders.at(-1) + 1) throw new ImageTimingError("INVALID_ASSIGNMENT_ORDER", "画像順とsegment順が一致しません。");
  }
  return groups.map((group, index) => {
    const start = index === 0 ? 0 : Number(segments[group.orders[0] - 1].timing.start_seconds);
    const end = index === groups.length - 1 ? totalDuration : Number(segments[groups[index + 1].orders[0] - 1].timing.start_seconds);
    return { image: group.image, start, end, segment_ids: group.orders.map((order) => segments[order - 1].id) };
  });
}

function planAutomatically(images, segments, totalDuration) {
  if (images.length <= segments.length) {
    const groups = images.map((image, index) => {
      const first = Math.floor(index * segments.length / images.length);
      const next = Math.floor((index + 1) * segments.length / images.length);
      return { image, first, segment_ids: segments.slice(first, next).map((segment) => segment.id) };
    });
    return groups.map((group, index) => ({
      image: group.image,
      start: index === 0 ? 0 : Number(segments[group.first].timing.start_seconds),
      end: index === groups.length - 1 ? totalDuration : Number(segments[groups[index + 1].first].timing.start_seconds),
      segment_ids: group.segment_ids,
    }));
  }
  return images.map((image, index) => {
    const start = totalDuration * index / images.length;
    const end = index === images.length - 1 ? totalDuration : totalDuration * (index + 1) / images.length;
    return { image, start, end, segment_ids: overlappingSegments(segments, start, end) };
  });
}

function applyImageTiming(job) {
  const { images, segments, totalDuration } = orderedInputs(job);
  const hasDurations = images.some((image) => image.requested_duration_seconds !== null && image.requested_duration_seconds !== undefined);
  const hasSegments = images.some((image) => Array.isArray(image.segment_ids) && image.segment_ids.length > 0);
  let mode;
  let planned;
  if (hasDurations && hasSegments) {
    mode = "explicit_segments_and_durations";
    planned = planByExplicitSegments(images, segments, totalDuration);
    for (const item of planned) {
      if (Math.abs(Number(item.image.requested_duration_seconds) - (item.end - item.start)) > EPSILON) {
        throw new ImageTimingError("IMAGE_DURATION_MISMATCH", "segment指定から求めた表示時間と明示時間が一致しません。");
      }
    }
  } else {
    mode = hasDurations ? "requested_durations" : (hasSegments ? "explicit_segments" : (images.length <= segments.length ? "automatic_segments" : "equal_duration"));
    planned = hasDurations ? planByDurations(images, segments, totalDuration) : (hasSegments ? planByExplicitSegments(images, segments, totalDuration) : planAutomatically(images, segments, totalDuration));
  }

  let cursor = 0;
  const primaryImage = new Map();
  for (const item of planned) {
    if (Math.abs(item.start - cursor) > EPSILON || item.end <= item.start || item.end > totalDuration + EPSILON) {
      throw new ImageTimingError("INVALID_IMAGE_TIMELINE", "画像表示区間が連続していません。");
    }
    item.image.segment_ids = [...item.segment_ids];
    item.image.start_seconds = round(item.start);
    item.image.end_seconds = round(item.end);
    item.image.duration_seconds = round(item.end - item.start);
    cursor = item.end;
  }
  if (Math.abs(cursor - totalDuration) > EPSILON) throw new ImageTimingError("INCOMPLETE_IMAGE_TIMELINE", "画像表示区間が音声全体を覆っていません。");
  for (const segment of segments) {
    const midpoint = (Number(segment.timing.start_seconds) + Number(segment.timing.end_seconds)) / 2;
    const owner = planned.find((item) => midpoint >= item.start - EPSILON && midpoint < item.end - EPSILON) || planned.at(-1);
    primaryImage.set(segment.id, owner.image.id);
  }
  for (const segment of job.segments) segment.image_id = primaryImage.get(segment.id);
  return { job, mode, total_duration_seconds: round(totalDuration) };
}

function planAndSaveManualImages(jobId, options = {}) {
  const file = resolveJobFile(options.root, jobId);
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  const complete = original.status === "images_ready" && original.current_stage === "images_ready"
    && original.images.every((image) => Number.isFinite(image.start_seconds) && Number.isFinite(image.end_seconds) && Number.isFinite(image.duration_seconds));
  if (complete) return { job: original, mode: "saved", total_duration_seconds: Math.max(...original.images.map((image) => image.end_seconds)), reused: true };
  const updated = structuredClone(original);
  const result = applyImageTiming(updated);
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new ImageTimingError("INVALID_TIME", "更新日時が不正です。");
  updated.status = "images_ready";
  updated.current_stage = "images_ready";
  updated.updated_at = now.toISOString();
  updated.error = null;
  updated.history.push({ at: updated.updated_at, stage: "image_planning", message: `画像表示区間を計算: ${result.mode}` });
  updated.history.push({ at: updated.updated_at, stage: "images_ready", message: `${updated.images.length}画像の順序と時間を保存` });
  atomicWriteJson(file, updated);
  return { ...result, job: updated, reused: false };
}

module.exports = { ImageTimingError, applyImageTiming, planAndSaveManualImages };
