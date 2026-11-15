"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;

class RegenerationError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = "RegenerationError"; this.code = code; this.statusCode = statusCode; }
}

function createDirectory(root, now) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `job_${stamp}_${crypto.randomBytes(6).toString("hex")}`;
    const directory = path.join(root, id);
    try { fs.mkdirSync(directory, { mode: 0o770 }); return { id, directory }; } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  throw new RegenerationError("JOB_ID_COLLISION", "再生成job IDを作成できません。", 503);
}

function copyFile(source, target) {
  if (!fs.existsSync(source) || !fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new RegenerationError("REUSABLE_FILE_MISSING", "再利用する成果物が見つかりません。", 409);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

function regenerateManualJob(sourceJobId, options = {}) {
  if (!options.root) throw new RegenerationError("ROOT_NOT_CONFIGURED", "手動ジョブ保存先が設定されていません。", 503);
  if (!JOB_ID_PATTERN.test(String(sourceJobId || ""))) throw new RegenerationError("INVALID_JOB_ID", "元job IDが不正です。");
  const root = fs.realpathSync(path.resolve(options.root));
  const sourceDirectory = fs.realpathSync(path.join(root, sourceJobId));
  if (!sourceDirectory.startsWith(`${root}${path.sep}`)) throw new RegenerationError("UNSAFE_PATH", "手動ジョブルート外は再生成できません。");
  const source = JSON.parse(fs.readFileSync(path.join(sourceDirectory, "job.json"), "utf8"));
  if (source.version !== 2 || source.mode !== "manual" || source.job_id !== sourceJobId) throw new RegenerationError("INVALID_MANUAL_JOB", "version 2手動jobだけを再生成できます。");
  const blockMode = Array.isArray(source.audio_blocks) && source.audio_blocks.length > 0;
  if (!Array.isArray(source.segments) || !source.segments.length
    || (!blockMode && source.segments.some((segment) => segment.audio.status !== "generated" || !Number.isFinite(segment.audio.duration_seconds)))
    || (blockMode && source.audio_blocks.some((block) => block.status !== "completed" || !Number.isFinite(block.duration_seconds)))) {
    throw new RegenerationError("AUDIO_NOT_REUSABLE", "全音声が揃っていません。", 409);
  }
  if (!Array.isArray(source.images) || !source.images.length || source.images.some((image) => !Number.isFinite(image.start_seconds) || !Number.isFinite(image.end_seconds) || !Number.isFinite(image.duration_seconds))) throw new RegenerationError("IMAGES_NOT_REUSABLE", "画像計画が揃っていません。", 409);
  const anomalySegmentIds = source.audio_quality && Array.isArray(source.audio_quality.anomalies)
    ? source.audio_quality.anomalies.map((item) => item && (blockMode ? item.audio_block_id : item.segment_id)).filter(Boolean)
    : [];
  const requestedSegmentIds = Array.isArray(options.segmentIds) ? options.segmentIds : anomalySegmentIds;
  const partialAudio = requestedSegmentIds.length > 0;
  const selected = new Set(requestedSegmentIds);
  if (partialAudio && (selected.size !== requestedSegmentIds.length
    || [...selected].some((id) => !(blockMode ? source.audio_blocks : source.segments).some((item) => item.id === id)))) {
    throw new RegenerationError("INVALID_REGENERATION_SEGMENTS", "部分再生成する音声単位が不正です。", 400);
  }
  const previousRegenerations = Number(source.audio_quality && source.audio_quality.regeneration_count
    || source.regeneration && source.regeneration.audio_quality_regeneration_count || 0);
  const maxRegenerations = Number(source.audio_quality && source.audio_quality.max_regenerations || 2);
  if (partialAudio && previousRegenerations >= maxRegenerations) {
    throw new RegenerationError("AUDIO_REGENERATION_LIMIT", "音声の部分再生成上限に達しています。", 409);
  }
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new RegenerationError("INVALID_TIME", "再生成日時が不正です。");
  const logicalRoot = String(options.logicalRoot || "/data/slideshow/manual_jobs").replace(/\/+$/, "");
  const expectedAudio = path.posix.join(logicalRoot, sourceJobId, "audio", "assembled.wav");
  const expectedSubtitle = path.posix.join(logicalRoot, sourceJobId, "subtitles", "final.srt");
  if (source.artifacts.audio_file !== expectedAudio || source.artifacts.subtitle_file !== expectedSubtitle) throw new RegenerationError("ARTIFACT_PATH_MISMATCH", "再利用成果物の論理パスが一致しません。", 409);
  const created = createDirectory(root, now);
  try {
    for (const name of ["uploads", "audio", "subtitles", "video"]) fs.mkdirSync(path.join(created.directory, name), { mode: 0o770 });
    const copiedUploads = new Set();
    for (const image of source.images) {
      if (image.source !== "upload") continue;
      if (!image.stored_filename || copiedUploads.has(image.stored_filename)) continue;
      copyFile(path.join(sourceDirectory, "uploads", image.stored_filename), path.join(created.directory, "uploads", image.stored_filename));
      copiedUploads.add(image.stored_filename);
    }
    for (const unit of (blockMode ? source.audio_blocks : source.segments)) {
      if (!partialAudio || !selected.has(unit.id)) {
        copyFile(path.join(sourceDirectory, "audio", `${unit.id}.wav`), path.join(created.directory, "audio", `${unit.id}.wav`));
      }
    }
    if (!partialAudio) {
      copyFile(path.join(sourceDirectory, "audio", "assembled.wav"), path.join(created.directory, "audio", "assembled.wav"));
      copyFile(path.join(sourceDirectory, "subtitles", "final.srt"), path.join(created.directory, "subtitles", "final.srt"));
    }

    const timestamp = now.toISOString();
    const job = structuredClone(source);
    job.job_id = created.id; job.status = partialAudio ? "audio_generating" : "images_ready"; job.current_stage = job.status; job.created_at = timestamp; job.updated_at = timestamp; job.attempts = 0; job.error = null; job.archive = null;
    job.regeneration = {
      source_job_id: sourceJobId,
      requested_at: timestamp,
      kind: partialAudio ? (blockMode ? "anomalous_audio_blocks" : "anomalous_audio_segments") : "full_material_reuse",
      segment_ids: partialAudio && !blockMode ? [...selected] : [],
      audio_block_ids: partialAudio && blockMode ? [...selected] : [],
      audio_quality_regeneration_count: partialAudio ? previousRegenerations + 1 : previousRegenerations,
      reused_segment_audio: !partialAudio,
      reused_assembled_audio: !partialAudio,
      reused_subtitle: !partialAudio,
      reused_images: true,
    };
    job.history = [{ at: timestamp, stage: job.status, message: partialAudio ? `${selected.size}件の異常候補音声だけを再生成する派生jobを作成` : `元job ${sourceJobId} の素材を再利用して再生成jobを作成` }];
    job.artifacts.audio_file = partialAudio ? null : path.posix.join(logicalRoot, created.id, "audio", "assembled.wav");
    job.artifacts.subtitle_file = partialAudio ? null : path.posix.join(logicalRoot, created.id, "subtitles", "final.srt");
    job.artifacts.video_file = null;
    job.output.filename = null;
    job.audio_quality = null;
    if (blockMode) {
      for (const block of job.audio_blocks) {
        if (partialAudio && selected.has(block.id)) {
          block.status = "pending"; block.audio_path = null; block.duration_seconds = null; block.started_at = null; block.completed_at = null; block.error = null;
        } else {
          block.audio_path = path.posix.join(logicalRoot, created.id, "audio", `${block.id}.wav`);
        }
      }
    } else {
      for (const segment of job.segments) {
        if (partialAudio && selected.has(segment.id)) {
          segment.audio = { status: "pending", path: null, duration_seconds: null, error: null };
          segment.timing = { start_seconds: null, end_seconds: null };
        } else {
          segment.audio.path = path.posix.join(logicalRoot, created.id, "audio", `${segment.id}.wav`);
        }
      }
    }
    if (partialAudio) {
      for (const segment of job.segments) segment.timing = { start_seconds: null, end_seconds: null };
      for (const image of job.images) { image.start_seconds = null; image.end_seconds = null; image.duration_seconds = null; }
    }
    for (const image of job.images) if (image.source === "upload") image.stored_path = path.posix.join(logicalRoot, created.id, "uploads", image.stored_filename);
    fs.writeFileSync(path.join(created.directory, "job.json"), `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o660 });
    return job;
  } catch (error) {
    fs.rmSync(created.directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { RegenerationError, regenerateManualJob };
