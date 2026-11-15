"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const STATUSES = new Set(["approved", "pending", "excluded"]);
const IMAGE_TYPES = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"]]);

class ImageLibraryReviewError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message); this.name = "ImageLibraryReviewError"; this.code = code; this.statusCode = statusCode;
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

function libraryRoot(root) {
  if (!root) throw new ImageLibraryReviewError("LIBRARY_NOT_CONFIGURED", "画像ライブラリが設定されていません。", 503);
  return fs.realpathSync(path.resolve(root));
}

function reviewStatus(metadata) {
  const explicit = metadata.review && metadata.review.status;
  if (STATUSES.has(explicit)) return explicit;
  const legacy = metadata.quality && metadata.quality.status;
  if (legacy === "approved") return "approved";
  if (["excluded", "rejected"].includes(legacy)) return "excluded";
  return "pending";
}

function sourceTimestamp(metadata, metadataFile) {
  return metadata.review && metadata.review.updated_at
    || metadata.lifecycle && metadata.lifecycle.updated_at
    || metadata.generation && metadata.generation.created_at
    || fs.statSync(metadataFile).mtime.toISOString();
}

function safeImage(root, metadata) {
  if (!metadata.file || typeof metadata.file.relative_path !== "string") throw new ImageLibraryReviewError("IMAGE_NOT_FOUND", "画像ファイルを確認できません。", 404);
  const relative = metadata.file.relative_path.replaceAll("\\", "/");
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new ImageLibraryReviewError("UNSAFE_IMAGE_PATH", "画像を安全に参照できません。", 500);
  let file;
  try { file = fs.realpathSync(candidate); } catch { throw new ImageLibraryReviewError("IMAGE_NOT_FOUND", "画像ファイルが見つかりません。", 404); }
  const stat = fs.lstatSync(file);
  if (!file.startsWith(`${root}${path.sep}`) || !stat.isFile() || stat.isSymbolicLink()) throw new ImageLibraryReviewError("UNSAFE_IMAGE_PATH", "画像を安全に参照できません。", 500);
  const mime = IMAGE_TYPES.get(path.extname(file).toLowerCase());
  if (!mime) throw new ImageLibraryReviewError("UNSUPPORTED_IMAGE", "表示できない画像形式です。", 415);
  return { file, mime, stat };
}

function loadAssets(root) {
  const realRoot = libraryRoot(root);
  const assets = [];
  for (const metadataFile of walkJson(path.join(realRoot, "metadata"))) {
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
      if (!ASSET_ID_PATTERN.test(String(metadata.asset_id || ""))) continue;
      const image = safeImage(realRoot, metadata);
      const hash = String(metadata.file.sha256 || "");
      assets.push({ metadata, metadataFile, image, status: reviewStatus(metadata), hash, updatedAt: sourceTimestamp(metadata, metadataFile) });
    } catch (error) {
      if (!(error instanceof ImageLibraryReviewError) || error.code !== "IMAGE_ARCHIVED") continue;
    }
  }
  return { root: realRoot, assets };
}

function publicAsset(asset) {
  const metadata = asset.metadata;
  return {
    asset_id: metadata.asset_id,
    title: String(metadata.content && metadata.content.title || metadata.asset_id).slice(0, 200),
    source_path: metadata.file.relative_path,
    original_filename: metadata.file.original_filename || path.basename(metadata.file.relative_path),
    saved_filename: metadata.file.saved_filename || path.basename(metadata.file.relative_path),
    sha256: asset.hash,
    width: metadata.file.width,
    height: metadata.file.height,
    mime_type: metadata.file.mime_type,
    size_bytes: Number(metadata.file.size_bytes || asset.image.stat.size),
    registration_source: metadata.registration_source || "api",
    registered_at: metadata.registered_at || null,
    status: asset.status,
    note: String(metadata.review && metadata.review.note || "").slice(0, 2000),
    tags: (metadata.review && Array.isArray(metadata.review.tags) ? metadata.review.tags : metadata.content && metadata.content.tags || []).slice(0, 30),
    updated_at: asset.updatedAt,
    created_at: metadata.generation && metadata.generation.created_at || null,
    reuse_count: Number(metadata.usage && metadata.usage.reuse_count || 0),
    last_used_at: metadata.usage && metadata.usage.last_used_at || null,
    thumbnail_url: `/api/image-library-admin/${encodeURIComponent(metadata.asset_id)}/thumbnail`,
  };
}

function listReviewAssets(root, options = {}) {
  const status = options.status ? String(options.status) : "all";
  if (status !== "all" && !STATUSES.has(status)) throw new ImageLibraryReviewError("INVALID_STATUS", "statusが不正です。");
  const sort = ["recent", "usage", "asset"].includes(options.sort) ? options.sort : "recent";
  const allAssets = loadAssets(root).assets;
  const assets = allAssets.filter((asset) => status === "all" || asset.status === status);
  assets.sort((left, right) => {
    if (sort === "usage") return Number(right.metadata.usage && right.metadata.usage.reuse_count || 0) - Number(left.metadata.usage && left.metadata.usage.reuse_count || 0) || String(right.metadata.usage && right.metadata.usage.last_used_at || "").localeCompare(String(left.metadata.usage && left.metadata.usage.last_used_at || ""));
    if (sort === "asset") return left.metadata.asset_id.localeCompare(right.metadata.asset_id);
    return right.updatedAt.localeCompare(left.updatedAt);
  });
  return {
    items: assets.map(publicAsset),
    counts: Object.fromEntries(["approved", "pending", "excluded"].map((value) => [value, allAssets.filter((asset) => asset.status === value).length])),
  };
}

function findAsset(root, assetId) {
  if (!ASSET_ID_PATTERN.test(String(assetId || ""))) throw new ImageLibraryReviewError("INVALID_ASSET_ID", "画像asset IDが不正です。");
  const loaded = loadAssets(root);
  const found = loaded.assets.find((asset) => asset.metadata.asset_id === assetId);
  if (!found) throw new ImageLibraryReviewError("ASSET_NOT_FOUND", "画像が見つかりません。", 404);
  return found;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) throw new ImageLibraryReviewError("INVALID_TAGS", "タグは配列で指定してください。");
  return [...new Set(tags.map((tag) => String(tag).trim().toLowerCase().replace(/[\s-]+/gu, "_")).filter((tag) => /^[\p{L}\p{N}_]{1,40}$/u.test(tag)))].slice(0, 30);
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o660 });
  fs.renameSync(temporary, file);
}

function updateReviewAsset(root, assetId, patch, now = new Date()) {
  const found = findAsset(root, assetId);
  const status = String(patch.status || "");
  if (!STATUSES.has(status)) throw new ImageLibraryReviewError("INVALID_STATUS", "approved、pending、excludedのいずれかを指定してください。");
  const note = String(patch.note || "").trim().slice(0, 2000);
  const tags = normalizeTags(patch.tags || []);
  const updatedAt = now.toISOString();
  const metadata = found.metadata;
  metadata.review = { status, note, tags, updated_at: updatedAt };
  metadata.content = { ...(metadata.content || {}), tags };
  metadata.quality = { ...(metadata.quality || {}), status, reviewed_at: updatedAt };
  metadata.search = { ...(metadata.search || {}), enabled: status !== "excluded" };
  metadata.lifecycle = {
    ...(metadata.lifecycle || {}),
    updated_at: updatedAt,
    history: [...(metadata.lifecycle && metadata.lifecycle.history || []), { action: "review-status", at: updatedAt, note: `${status}: ${note}`.slice(0, 500) }],
  };
  if (!metadata.file.sha256) metadata.file.sha256 = crypto.createHash("sha256").update(fs.readFileSync(found.image.file)).digest("hex");
  atomicWriteJson(found.metadataFile, metadata);
  return publicAsset({ ...found, metadata, status, hash: metadata.file.sha256, updatedAt });
}

function getReviewImage(root, assetId) {
  const found = findAsset(root, assetId);
  return found.image;
}

module.exports = { ImageLibraryReviewError, getReviewImage, listReviewAssets, reviewStatus, updateReviewAsset };
