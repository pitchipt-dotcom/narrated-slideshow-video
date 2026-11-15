"use strict";

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { imageInfo } = require("./manual-image-library-registration");

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"]);
const ACCEPTED_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);

class ImageLibraryUploadError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message); this.name = "ImageLibraryUploadError"; this.code = code; this.statusCode = statusCode;
  }
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

function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o660 });
  fs.renameSync(temporary, file);
}

function sniff(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (bytes.length >= 16 && bytes.toString("ascii", 4, 8) === "ftyp" && /heic|heix|hevc|hevx|heim|heis|heif|mif1|msf1/u.test(bytes.toString("ascii", 8, 16))) return "heic";
  return null;
}

function tagsFrom(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(["manual_upload", ...values].map((tag) => String(tag).trim().toLowerCase().replace(/[\s-]+/gu, "_")).filter((tag) => /^[\p{L}\p{N}_]{1,40}$/u.test(tag)))].slice(0, 30);
}

function safeOriginalName(name) {
  return path.basename(String(name || "image")).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 240) || "image";
}

function normalizeImage(upload, temporaryRoot) {
  const originalFilename = safeOriginalName(upload.name);
  const extension = path.extname(originalFilename).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.has(extension)) throw new ImageLibraryUploadError("UNSUPPORTED_EXTENSION", `${originalFilename}: PNG、JPEG、WebP、HEIC/HEIFだけ登録できます。`, 415);
  const claimedMime = String(upload.type || "").toLowerCase();
  if (!claimedMime || !ACCEPTED_MIME.has(claimedMime)) throw new ImageLibraryUploadError("UNSUPPORTED_MIME", `${originalFilename}: MIMEタイプを画像として確認できません。`, 415);
  const detected = sniff(upload.bytes);
  if (!detected) throw new ImageLibraryUploadError("INVALID_IMAGE_CONTENT", `${originalFilename}: 画像ファイルの実体を確認できません。`, 415);
  const expected = extension === ".jpeg" ? "jpg" : extension.slice(1);
  if (!(detected === expected || (detected === "heic" && ["heic", "heif"].includes(expected)))) {
    throw new ImageLibraryUploadError("IMAGE_TYPE_MISMATCH", `${originalFilename}: 拡張子と画像実体が一致しません。`, 415);
  }
  const input = path.join(temporaryRoot, `input-${crypto.randomUUID()}${extension}`);
  const outputExtension = detected === "heic" ? "jpg" : detected;
  const output = path.join(temporaryRoot, `output-${crypto.randomUUID()}.${outputExtension}`);
  fs.writeFileSync(input, upload.bytes, { flag: "wx", mode: 0o600 });
  const codec = outputExtension === "jpg" ? ["-q:v", "2"] : outputExtension === "webp" ? ["-quality", "92"] : [];
  const command = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-frames:v", "1",
    "-vf", "scale=w='min(4096,iw)':h='min(4096,ih)':force_original_aspect_ratio=decrease",
    "-map_metadata", "-1", ...codec, output,
  ], { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
  if (command.status !== 0 || !fs.existsSync(output)) {
    const heic = detected === "heic" ? " HEIC/HEIF変換に対応していない可能性があります。" : "";
    throw new ImageLibraryUploadError("IMAGE_CONVERSION_FAILED", `${originalFilename}: 画像を変換できませんでした。${heic}`, 422);
  }
  const info = imageInfo(output);
  if (info.width < 256 || info.height < 256) throw new ImageLibraryUploadError("IMAGE_TOO_SMALL", `${originalFilename}: 短辺・長辺とも256px以上の画像を使用してください。`, 422);
  const normalized = fs.readFileSync(output);
  return {
    originalFilename, outputExtension, mimeType: info.mime_type, width: info.width, height: info.height,
    bytes: normalized, sha256: crypto.createHash("sha256").update(normalized).digest("hex"),
  };
}

function existingByHash(root) {
  const map = new Map();
  for (const file of walkJson(path.join(root, "metadata"))) {
    try {
      const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
      if (metadata.file && metadata.file.sha256) map.set(metadata.file.sha256, metadata);
    } catch {}
  }
  return map;
}

function createMetadata(image, fields, now) {
  const assetId = `manual_upload_${image.sha256.slice(0, 24)}`;
  const savedFilename = `${assetId}.${image.outputExtension}`;
  const relativePath = `generated/review/manual_upload/${savedFilename}`;
  const tags = tagsFrom(fields.tags);
  const note = String(fields.note || "").trim().slice(0, 2000);
  return {
    schema_version: 1,
    asset_id: assetId,
    registration_source: "manual_upload",
    registered_at: now,
    lifecycle: { state: "review", updated_at: now, history: [{ action: "generated", at: now, note: `manual upload: ${image.originalFilename}` }] },
    classification: { type: "common", category: "manual_upload", theme: null, video_id: null },
    file: {
      relative_path: relativePath, original_filename: image.originalFilename, saved_filename: savedFilename,
      sha256: image.sha256, mime_type: image.mimeType, width: image.width, height: image.height, size_bytes: image.bytes.length,
    },
    content: { title: image.originalFilename.replace(/\.[^.]+$/u, "").slice(0, 120), description: "画像ライブラリ管理画面から手動登録", tags, keywords: tags, negative_tags: [] },
    search: { enabled: true, reuse_priority: 50, minimum_context_match: 0.6 },
    composition: { focal_point: { x: 0.5, y: 0.5 }, subject_position: "none", safe_text_areas: [], allow_horizontal_flip: false, flip_block_reasons: ["other"], crop_safety: "limited" },
    quality: { status: "pending", issues: ["Human review required"], reviewed_at: null },
    review: { status: "pending", note, tags, updated_at: now },
    rights: { source_type: "owned", license: "user-confirmed-manual-upload", commercial_use: true, attribution_required: false, source_url: null },
    generation: { generator: "manual", created_at: now, prompt: null, negative_prompt: null, model: null, workflow: "manual_upload; ffmpeg autorotate; metadata stripped", seed: null, steps: null },
    usage: { reuse_count: 0, last_used_at: null, max_consecutive_scenes: 1, recent_video_ids: [] },
  };
}

function registerUploadedImages(root, uploads, fields = {}, options = {}) {
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES;
  if (!Array.isArray(uploads) || !uploads.length) throw new ImageLibraryUploadError("NO_IMAGES", "追加する画像を選択してください。");
  if (uploads.length > maxFiles) throw new ImageLibraryUploadError("TOO_MANY_FILES", `1回に登録できる画像は${maxFiles}枚までです。`, 413);
  if (fields.rightsConfirmed !== true) throw new ImageLibraryUploadError("RIGHTS_CONFIRMATION_REQUIRED", "アップロード権限と利用権を確認してください。", 400);
  const total = uploads.reduce((sum, upload) => sum + upload.bytes.length, 0);
  if (total > maxTotalBytes) throw new ImageLibraryUploadError("UPLOAD_TOTAL_TOO_LARGE", `1回の合計容量は${Math.floor(maxTotalBytes / 1048576)}MBまでです。`, 413);
  for (const upload of uploads) if (upload.bytes.length > maxFileBytes) throw new ImageLibraryUploadError("FILE_TOO_LARGE", `${safeOriginalName(upload.name)}: 1ファイル${Math.floor(maxFileBytes / 1048576)}MBまでです。`, 413);
  const realRoot = fs.realpathSync(path.resolve(root));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "image-library-upload-"));
  const lockFile = path.join(realRoot, ".manual-upload.lock");
  let lock;
  try {
    const normalized = uploads.map((upload) => normalizeImage(upload, temporaryRoot));
    try { lock = fs.openSync(lockFile, "wx", 0o660); } catch (error) {
      if (error.code === "EEXIST") throw new ImageLibraryUploadError("LIBRARY_BUSY", "画像ライブラリを更新中です。少し待って再試行してください。", 409);
      throw error;
    }
    const duplicates = existingByHash(realRoot);
    const now = (options.now || new Date()).toISOString();
    const items = [];
    for (const image of normalized) {
      const duplicate = duplicates.get(image.sha256);
      if (duplicate) {
        items.push({ duplicate: true, asset_id: duplicate.asset_id, original_filename: image.originalFilename, message: `既存画像 ${duplicate.asset_id} と完全一致しました。` });
        continue;
      }
      const metadata = createMetadata(image, fields, now);
      const imageFile = path.join(realRoot, metadata.file.relative_path);
      const metadataFile = path.join(realRoot, "metadata", "review", `${metadata.asset_id}.json`);
      if (fs.existsSync(imageFile) || fs.existsSync(metadataFile)) throw new ImageLibraryUploadError("ASSET_COLLISION", `${image.originalFilename}: 保存名が競合しました。`, 409);
      fs.mkdirSync(path.dirname(imageFile), { recursive: true, mode: 0o770 });
      fs.mkdirSync(path.dirname(metadataFile), { recursive: true, mode: 0o770 });
      const temporaryImage = `${imageFile}.tmp-${process.pid}`;
      fs.writeFileSync(temporaryImage, image.bytes, { flag: "wx", mode: 0o660 });
      fs.renameSync(temporaryImage, imageFile);
      try { atomicWriteJson(metadataFile, metadata); } catch (error) { fs.unlinkSync(imageFile); throw error; }
      duplicates.set(image.sha256, metadata);
      items.push({ duplicate: false, asset_id: metadata.asset_id, original_filename: image.originalFilename, status: "pending" });
    }
    return { items, registered: items.filter((item) => !item.duplicate).length, duplicates: items.filter((item) => item.duplicate).length };
  } finally {
    if (lock !== undefined) { try { fs.closeSync(lock); } finally { try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== "ENOENT") throw error; } } }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

module.exports = {
  DEFAULT_MAX_FILES, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_TOTAL_BYTES,
  ImageLibraryUploadError, registerUploadedImages, sniff,
};
