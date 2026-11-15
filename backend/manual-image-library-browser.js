"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,63}$/;
const MAX_PAGE_SIZE = 50;

class ImageLibraryBrowserError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ImageLibraryBrowserError";
    this.code = code;
    this.statusCode = statusCode;
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

function approved(metadata) {
  return metadata && ASSET_ID_PATTERN.test(String(metadata.asset_id || ""))
    && metadata.quality && metadata.quality.status === "approved"
    && metadata.search && metadata.search.enabled === true
    && metadata.rights && metadata.rights.commercial_use === true
    && metadata.lifecycle && ["common", "theme"].includes(metadata.lifecycle.state)
    && metadata.file && typeof metadata.file.relative_path === "string";
}

function loadApprovedAssets(root) {
  if (!root) throw new ImageLibraryBrowserError("LIBRARY_NOT_CONFIGURED", "画像ライブラリが設定されていません。", 503);
  const realRoot = fs.realpathSync(path.resolve(root));
  const assets = [];
  for (const metadataFile of walkJson(path.join(realRoot, "metadata"))) {
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
      if (!approved(metadata)) continue;
      const candidate = path.resolve(realRoot, metadata.file.relative_path);
      if (!candidate.startsWith(`${realRoot}${path.sep}`)) continue;
      const realFile = fs.realpathSync(candidate);
      if (!realFile.startsWith(`${realRoot}${path.sep}`) || !fs.lstatSync(realFile).isFile()) continue;
      assets.push({ metadata, file: realFile });
    } catch {}
  }
  assets.sort((left, right) => left.metadata.asset_id.localeCompare(right.metadata.asset_id));
  return { root: realRoot, assets };
}

function listApprovedAssets(root, options = {}) {
  const limit = options.limit === undefined ? 12 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new ImageLibraryBrowserError("INVALID_LIMIT", `limitは1〜${MAX_PAGE_SIZE}で指定してください。`);
  const cursor = options.cursor ? String(options.cursor) : null;
  if (cursor && !ASSET_ID_PATTERN.test(cursor)) throw new ImageLibraryBrowserError("INVALID_CURSOR", "cursorが不正です。");
  const loaded = loadApprovedAssets(root);
  const start = cursor ? loaded.assets.findIndex((asset) => asset.metadata.asset_id > cursor) : 0;
  const offset = start < 0 ? loaded.assets.length : start;
  const page = loaded.assets.slice(offset, offset + limit);
  const hasMore = offset + page.length < loaded.assets.length;
  return {
    items: page.map(({ metadata }) => ({
      asset_id: metadata.asset_id,
      title: metadata.content.title,
      tags: (metadata.content.tags || []).slice(0, 8),
      width: metadata.file.width,
      height: metadata.file.height,
      thumbnail_url: `/api/manual-image-library/${encodeURIComponent(metadata.asset_id)}/thumbnail`,
    })),
    next_cursor: hasMore && page.length ? page.at(-1).metadata.asset_id : null,
  };
}

function getApprovedAsset(root, assetId) {
  if (!ASSET_ID_PATTERN.test(String(assetId || ""))) throw new ImageLibraryBrowserError("INVALID_ASSET_ID", "画像asset IDが不正です。");
  const loaded = loadApprovedAssets(root);
  const found = loaded.assets.find((asset) => asset.metadata.asset_id === assetId);
  if (!found) throw new ImageLibraryBrowserError("ASSET_NOT_FOUND", "利用可能な画像が見つかりません。", 404);
  return found;
}

function resolveLibrarySelections(root, assetIds, options = {}) {
  const ids = Array.isArray(assetIds) ? assetIds.map(String) : [];
  if (ids.length > 20 || new Set(ids).size !== ids.length) throw new ImageLibraryBrowserError("INVALID_LIBRARY_SELECTION", "ライブラリ画像は重複なしで20枚以内にしてください。");
  const logicalRoot = String(options.logicalRoot || "/data/slideshow/images/library").replace(/\/+$/, "");
  return ids.map((assetId) => {
    const { metadata } = getApprovedAsset(root, assetId);
    return {
      assetId,
      originalFilename: path.posix.basename(metadata.file.relative_path),
      storedFilename: path.posix.basename(metadata.file.relative_path),
      storedPath: path.posix.join(logicalRoot, metadata.file.relative_path),
      sha256: metadata.file.sha256,
    };
  });
}

module.exports = { ImageLibraryBrowserError, getApprovedAsset, listApprovedAssets, resolveLibrarySelections };
