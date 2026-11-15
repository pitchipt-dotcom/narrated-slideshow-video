"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getReviewImage, listReviewAssets, updateReviewAsset } = require("../backend/image-library-review");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-review-"));
try {
  const metadataRoot = path.join(root, "metadata", "review"); const imageRoot = path.join(root, "generated", "review");
  fs.mkdirSync(metadataRoot, { recursive: true }); fs.mkdirSync(imageRoot, { recursive: true });
  const id = "review_asset_001"; const bytes = Buffer.from("fake-png");
  fs.writeFileSync(path.join(imageRoot, `${id}.png`), bytes);
  fs.writeFileSync(path.join(metadataRoot, `${id}.json`), JSON.stringify({
    asset_id: id,
    lifecycle: { state: "review", updated_at: "2026-07-20T00:00:00Z", history: [] },
    classification: { type: "common", category: "test", theme: null, video_id: null },
    file: { relative_path: `generated/review/${id}.png`, sha256: crypto.createHash("sha256").update(bytes).digest("hex") },
    content: { title: "評価画像", tags: ["old"] },
    quality: { status: "pending" }, search: { enabled: true }, usage: { reuse_count: 2, last_used_at: "2026-07-21T00:00:00Z" },
  }));
  let listed = listReviewAssets(root, { status: "pending", sort: "usage" });
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].status, "pending"); assert.equal(listed.items[0].source_path, `generated/review/${id}.png`);
  const originalPath = listed.items[0].source_path;
  const updated = updateReviewAsset(root, id, { status: "excluded", note: "人物数が不正確", tags: ["歩行 練習", "医療"] }, new Date("2026-07-26T04:00:00Z"));
  assert.equal(updated.status, "excluded"); assert.deepEqual(updated.tags, ["歩行_練習", "医療"]); assert.equal(updated.source_path, originalPath);
  listed = listReviewAssets(root, { status: "excluded" }); assert.equal(listed.items.length, 1); assert.equal(listed.counts.excluded, 1);
  const image = getReviewImage(root, id); assert.equal(image.mime, "image/png"); assert.equal(fs.readFileSync(image.file).toString(), "fake-png");
  const metadata = JSON.parse(fs.readFileSync(path.join(metadataRoot, `${id}.json`), "utf8"));
  assert.equal(metadata.search.enabled, false); assert.equal(metadata.quality.status, "excluded"); assert.equal(metadata.review.note, "人物数が不正確");
  console.log("image library review tests: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
