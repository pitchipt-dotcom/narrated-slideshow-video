"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const IMAGE_ID_PATTERN = /^image_[0-9]{3,}$/;
const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const RIGHTS_SOURCE_TYPES = new Set(["ai_generated", "owned", "licensed", "public_domain"]);

class ImageLibraryRegistrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ImageLibraryRegistrationError";
    this.code = code;
  }
}

function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o660 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; }
    throw error;
  }
}

function atomicWriteJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function walkJson(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walkJson(target, output);
    else if (entry.isFile() && entry.name.endsWith(".json")) output.push(target);
  }
  return output;
}

function resolveInputs(jobRoot, libraryRoot, jobId, imageId) {
  if (!jobRoot || !libraryRoot) throw new ImageLibraryRegistrationError("ROOT_NOT_CONFIGURED", "ジョブと画像ライブラリの保存先が必要です。");
  if (!JOB_ID_PATTERN.test(String(jobId || "")) || !IMAGE_ID_PATTERN.test(String(imageId || ""))) throw new ImageLibraryRegistrationError("INVALID_ID", "ジョブIDまたは画像IDが不正です。");
  const realJobRoot = fs.realpathSync(path.resolve(jobRoot));
  const jobDirectory = fs.realpathSync(path.join(realJobRoot, jobId));
  if (!jobDirectory.startsWith(`${realJobRoot}${path.sep}`)) throw new ImageLibraryRegistrationError("UNSAFE_PATH", "手動ジョブルート外は参照できません。");
  const realLibraryRoot = fs.realpathSync(path.resolve(libraryRoot));
  const jobFile = path.join(jobDirectory, "job.json");
  if (fs.lstatSync(jobFile).isSymbolicLink()) throw new ImageLibraryRegistrationError("UNSAFE_PATH", "シンボリックリンクのジョブは更新できません。");
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  if (job.version !== 2 || job.mode !== "manual" || job.job_id !== jobId) throw new ImageLibraryRegistrationError("INVALID_MANUAL_JOB", "version 2手動ジョブだけを処理できます。");
  const image = Array.isArray(job.images) ? job.images.find((item) => item.id === imageId) : null;
  if (!image || image.source !== "upload" || !image.stored_filename || !image.sha256) throw new ImageLibraryRegistrationError("INVALID_UPLOAD_IMAGE", "登録可能なアップロード画像がありません。");
  const uploadDirectory = fs.realpathSync(path.join(jobDirectory, "uploads"));
  const sourceFile = path.join(uploadDirectory, image.stored_filename);
  if (!fs.existsSync(sourceFile) || !fs.lstatSync(sourceFile).isFile() || fs.lstatSync(sourceFile).isSymbolicLink()) throw new ImageLibraryRegistrationError("IMAGE_FILE_MISSING", "アップロード原本がありません。");
  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(sourceFile)).digest("hex");
  if (actualHash !== image.sha256) throw new ImageLibraryRegistrationError("IMAGE_HASH_MISMATCH", "アップロード画像のハッシュがjob.jsonと一致しません。");
  return { job, jobFile, image, sourceFile, libraryRoot: realLibraryRoot };
}

function imageInfo(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime_type: "image/png", extension: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { mime_type: "image/jpeg", extension: "jpg", height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const size = buffer.readUInt16BE(offset + 2);
      if (size < 2) break;
      offset += 2 + size;
    }
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const kind = buffer.toString("ascii", 12, 16);
    if (kind === "VP8X") return { mime_type: "image/webp", extension: "webp", width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    if (kind === "VP8L" && buffer[20] === 0x2f) return { mime_type: "image/webp", extension: "webp", width: 1 + buffer[21] + ((buffer[22] & 0x3f) << 8), height: 1 + (buffer[22] >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10) };
    if (kind === "VP8 " && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) return { mime_type: "image/webp", extension: "webp", width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  throw new ImageLibraryRegistrationError("UNSUPPORTED_IMAGE", "画像形式または寸法を確認できません。");
}

function validateRights(rights) {
  if (!rights || !RIGHTS_SOURCE_TYPES.has(rights.source_type) || typeof rights.license !== "string" || !rights.license.trim()
    || typeof rights.commercial_use !== "boolean" || typeof rights.attribution_required !== "boolean") {
    throw new ImageLibraryRegistrationError("RIGHTS_CONFIRMATION_REQUIRED", "画像の出所・ライセンス・商用利用・帰属表示条件を明示してください。");
  }
  return { source_type: rights.source_type, license: rights.license.trim().slice(0, 200), commercial_use: rights.commercial_use, attribution_required: rights.attribution_required, source_url: rights.source_url || null };
}

function findDuplicate(libraryRoot, sha256) {
  const matches = [];
  for (const file of walkJson(path.join(libraryRoot, "metadata"))) {
    try {
      const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
      if (metadata.file && metadata.file.sha256 === sha256) matches.push({ file, metadata });
    } catch {}
  }
  if (matches.length > 1) throw new ImageLibraryRegistrationError("DUPLICATE_METADATA", "同じハッシュのmetadataが複数あります。");
  return matches[0] || null;
}

function assetIdFor(image, existingIds) {
  const ordinal = image.id.slice("image_".length);
  for (const length of [12, 16, 20, 24]) {
    const candidate = `manual_video_${image.sha256.slice(0, length)}_${ordinal}`;
    if (ASSET_ID_PATTERN.test(candidate) && !existingIds.has(candidate)) return candidate;
  }
  throw new ImageLibraryRegistrationError("ASSET_ID_COLLISION", "一意な画像asset IDを作成できませんでした。");
}

function normalizeTags(tags) {
  const values = ["manual_upload", ...(Array.isArray(tags) ? tags : [])]
    .map((value) => String(value).trim().toLowerCase()).filter((value) => /^[a-z0-9_]+$/u.test(value));
  return [...new Set(values)].slice(0, 30);
}

function registerManualImage(jobId, imageId, options = {}) {
  const input = resolveInputs(options.jobRoot, options.libraryRoot, jobId, imageId);
  if (input.image.library_asset_id) return { asset_id: input.image.library_asset_id, duplicate: true, reused: true };
  const rights = validateRights(options.rights);
  const info = imageInfo(input.sourceFile);
  if (info.width < 256 || info.height < 256) throw new ImageLibraryRegistrationError("IMAGE_TOO_SMALL_FOR_LIBRARY", "画像ライブラリには256px以上の画像が必要です。");
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new ImageLibraryRegistrationError("INVALID_TIME", "登録日時が不正です。");
  const timestamp = now.toISOString();
  const lockFile = path.join(input.libraryRoot, ".manual-register.lock");
  let lock;
  try { lock = fs.openSync(lockFile, "wx", 0o660); } catch (error) {
    if (error.code === "EEXIST") throw new ImageLibraryRegistrationError("LIBRARY_BUSY", "画像ライブラリ登録は実行中です。");
    throw error;
  }
  let createdImage = null;
  let createdMetadata = null;
  let duplicateBackup = null;
  try {
    const duplicate = findDuplicate(input.libraryRoot, input.image.sha256);
    let metadata;
    let metadataFile;
    let assetId;
    if (duplicate) {
      metadata = duplicate.metadata;
      metadataFile = duplicate.file;
      assetId = metadata.asset_id;
      duplicateBackup = { file: metadataFile, content: fs.readFileSync(metadataFile, "utf8") };
      const recent = [jobId, ...(metadata.usage.recent_video_ids || []).filter((value) => value !== jobId)].slice(0, 50);
      metadata.usage.reuse_count = Number(metadata.usage.reuse_count || 0) + 1;
      metadata.usage.last_used_at = timestamp;
      metadata.usage.recent_video_ids = recent;
      metadata.lifecycle.updated_at = timestamp;
      metadata.lifecycle.history.push({ action: "mark-used", at: timestamp, note: jobId });
      atomicWriteJson(metadataFile, metadata);
    } else {
      const existingIds = new Set(walkJson(path.join(input.libraryRoot, "metadata")).map((file) => {
        try { return JSON.parse(fs.readFileSync(file, "utf8")).asset_id; } catch { return null; }
      }).filter(Boolean));
      assetId = assetIdFor(input.image, existingIds);
      const relativePath = `generated/review/${assetId}.${info.extension}`;
      const targetImage = path.join(input.libraryRoot, relativePath);
      metadataFile = path.join(input.libraryRoot, "metadata", "review", `${assetId}.json`);
      fs.mkdirSync(path.dirname(targetImage), { recursive: true, mode: 0o770 });
      fs.mkdirSync(path.dirname(metadataFile), { recursive: true, mode: 0o770 });
      fs.copyFileSync(input.sourceFile, targetImage, fs.constants.COPYFILE_EXCL);
      createdImage = targetImage;
      metadata = {
        schema_version: 1,
        asset_id: assetId,
        registration_source: "manual_upload",
        registered_at: timestamp,
        lifecycle: { state: "review", updated_at: timestamp, history: [{ action: "generated", at: timestamp, note: `manual upload: ${input.image.original_filename}` }] },
        classification: { type: "video_specific", category: "manual_upload", theme: null, video_id: jobId },
        file: { relative_path: relativePath, original_filename: input.image.original_filename, saved_filename: path.basename(relativePath), sha256: input.image.sha256, mime_type: info.mime_type, width: info.width, height: info.height, size_bytes: fs.statSync(input.sourceFile).size },
        content: {
          title: String(input.job.input.title || input.image.original_filename).slice(0, 120),
          description: `手動動画ジョブ${jobId}で使用。元ファイル名: ${input.image.original_filename}`.slice(0, 1000),
          tags: normalizeTags(options.tags),
          keywords: [...new Set([String(input.job.input.title || "").trim(), input.image.original_filename].filter(Boolean))],
          negative_tags: [],
        },
        search: { enabled: true, reuse_priority: 0, minimum_context_match: 1 },
        composition: { focal_point: { x: 0.5, y: 0.5 }, subject_position: "none", safe_text_areas: [], allow_horizontal_flip: false, flip_block_reasons: ["other"], crop_safety: "unsafe" },
        quality: { status: "pending", issues: ["Human review required", "Rights metadata requires human verification"], reviewed_at: null },
        review: { status: "pending", note: "", tags: normalizeTags(options.tags), updated_at: timestamp },
        rights,
        generation: { generator: "manual", created_at: timestamp, prompt: null, negative_prompt: null, model: null, workflow: null, seed: null, steps: null },
        usage: { reuse_count: 1, last_used_at: timestamp, max_consecutive_scenes: 1, recent_video_ids: [jobId] },
      };
      atomicWriteJson(metadataFile, metadata);
      createdMetadata = metadataFile;
    }

    const latestJob = JSON.parse(fs.readFileSync(input.jobFile, "utf8"));
    if (latestJob.updated_at !== input.job.updated_at) throw new ImageLibraryRegistrationError("JOB_CHANGED", "登録中にジョブ状態が変更されました。");
    const latestImage = latestJob.images.find((item) => item.id === imageId);
    latestImage.library_asset_id = assetId;
    latestJob.updated_at = timestamp;
    latestJob.history.push({ at: timestamp, stage: latestJob.current_stage, message: `${imageId}を画像ライブラリ審査待ちへ登録` });
    atomicWriteJson(input.jobFile, latestJob);
    return { asset_id: assetId, duplicate: Boolean(duplicate), reused: false, metadata, job: latestJob };
  } catch (error) {
    if (duplicateBackup) {
      try { atomicWrite(duplicateBackup.file, duplicateBackup.content); } catch (cleanupError) { error.cleanupError = cleanupError; }
    }
    if (createdMetadata) { try { fs.unlinkSync(createdMetadata); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; } }
    if (createdImage) { try { fs.unlinkSync(createdImage); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; } }
    throw error;
  } finally {
    try { fs.closeSync(lock); } finally { try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  }
}

module.exports = { ImageLibraryRegistrationError, imageInfo, registerManualImage };
