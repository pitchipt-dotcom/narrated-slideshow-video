"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { updateReviewAsset } = require("../backend/image-library-review");
const { ImageLibraryUploadError, registerUploadedImages } = require("../backend/image-library-upload");

function fixture(file, size, format) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=skyblue:s=${size}:d=0.1`, "-frames:v", "1", file]);
  if (result.status !== 0) throw new Error(`fixture ${format} failed`);
  return fs.readFileSync(file);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "image-upload-"));
const root = path.join(temporary, "library");
fs.mkdirSync(path.join(root, "metadata", "review"), { recursive: true });
fs.mkdirSync(path.join(root, "generated", "review"), { recursive: true });
try {
  const png = fixture(path.join(temporary, "portrait.png"), "320x640", "png");
  const jpeg1 = fixture(path.join(temporary, "one.jpg"), "640x360", "jpeg");
  const jpeg2 = fixture(path.join(temporary, "two.jpg"), "800x600", "jpeg");
  const fields = { rightsConfirmed: true, note: "スマホ登録", tags: "歩行, リハビリ" };
  const pngResult = registerUploadedImages(root, [{ name: "縦長.png", type: "image/png", bytes: png }], fields);
  assert.equal(pngResult.registered, 1); assert.equal(pngResult.items[0].status, "pending");
  const multiple = registerUploadedImages(root, [
    { name: "同名.jpg", type: "image/jpeg", bytes: jpeg1 },
    { name: "同名.jpg", type: "image/jpeg", bytes: jpeg2 },
  ], fields);
  assert.equal(multiple.registered, 2); assert.notEqual(multiple.items[0].asset_id, multiple.items[1].asset_id);
  const duplicate = registerUploadedImages(root, [{ name: "別名.jpg", type: "image/jpeg", bytes: jpeg1 }], fields);
  assert.equal(duplicate.registered, 0); assert.equal(duplicate.duplicates, 1); assert.equal(duplicate.items[0].asset_id, multiple.items[0].asset_id);
  const portraitFile = path.join(root, "metadata", "review", `${pngResult.items[0].asset_id}.json`);
  let portrait = JSON.parse(fs.readFileSync(portraitFile, "utf8"));
  assert.equal(portrait.file.width, 320); assert.equal(portrait.file.height, 640); assert.equal(portrait.registration_source, "manual_upload");
  assert.equal(portrait.file.original_filename, "縦長.png"); assert(portrait.file.size_bytes > 0);
  updateReviewAsset(root, portrait.asset_id, { status: "approved", note: "採用", tags: ["歩行"] });
  portrait = JSON.parse(fs.readFileSync(portraitFile, "utf8"));
  assert.equal(portrait.quality.status, "approved"); assert.equal(portrait.search.enabled, true);
  updateReviewAsset(root, portrait.asset_id, { status: "excluded", note: "除外", tags: ["歩行"] });
  portrait = JSON.parse(fs.readFileSync(portraitFile, "utf8"));
  assert.equal(portrait.quality.status, "excluded"); assert.equal(portrait.search.enabled, false);
  assert.throws(() => registerUploadedImages(root, [{ name: "evil.png", type: "image/png", bytes: Buffer.from("#!/bin/sh") }], fields), (error) => error instanceof ImageLibraryUploadError && error.code === "INVALID_IMAGE_CONTENT");
  assert.throws(() => registerUploadedImages(root, [{ name: "big.png", type: "image/png", bytes: png }], fields, { maxFileBytes: 10 }), (error) => error.code === "FILE_TOO_LARGE");
  assert.throws(() => registerUploadedImages(root, new Array(11).fill({ name: "x.png", type: "image/png", bytes: png }), fields), (error) => error.code === "TOO_MANY_FILES");
  console.log("image library upload tests: ok");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
