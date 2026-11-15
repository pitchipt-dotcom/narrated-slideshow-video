"use strict";

const assert = require("node:assert/strict");
const { downloadFilenameForTitle, sanitizeVideoBasename } = require("../backend/video-filename");

assert.equal(downloadFilenameForTitle("サンプル（2022年版）を使った動画の作り方"), "サンプル_2022年版を使った動画の作り方.mp4");
assert.equal(downloadFilenameForTitle("サンプル 2022年版を使った動画の作り方"), "サンプル_2022年版を使った動画の作り方.mp4");
assert.equal(downloadFilenameForTitle(" . 危険 / \\ : * ? \" < > | 名前 . "), "危険_名前.mp4");
assert.equal(downloadFilenameForTitle("   "), "manual-video.mp4");
assert.equal(sanitizeVideoBasename("あ".repeat(120)).length, 100);
assert.equal(downloadFilenameForTitle("CON"), "_CON.mp4");

console.log("video filename tests: ok");
