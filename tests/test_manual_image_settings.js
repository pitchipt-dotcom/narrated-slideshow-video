"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { getManualImageSettings, updateManualImageSettings } = require("../backend/manual-image-settings");

function makeJob(jobId) {
  const at = "2026-07-14T14:00:00.000Z";
  const image = (id, order) => ({ id, source: order === 1 ? "upload" : "library", order, segment_ids: [], requested_duration_seconds: null, original_filename: `${id}.png`, stored_filename: `${id}.png`, stored_path: `/data/${id}.png`, sha256: String(order).repeat(64), start_seconds: null, end_seconds: null, duration_seconds: null, library_asset_id: order === 1 ? null : "common_settings_asset_001" });
  return {
    version: 2, mode: "manual", job_id: jobId, status: "subtitle_ready", current_stage: "subtitle_ready", created_at: at, updated_at: at,
    input: { title: "詳細設定", subtitle_text: "一二三", speech_text: "いちにさん", request_note: "" },
    segments: Array.from({ length: 3 }, (_, index) => ({ id: `seg_00${index + 1}`, order: index + 1, subtitle_text: `表示${index + 1}`, speech_text: `よみ${index + 1}`, image_id: null, requested_image_duration_seconds: null, audio: { status: "generated", path: `/data/seg${index + 1}.wav`, duration_seconds: 1, error: null }, timing: { start_seconds: index, end_seconds: index + 1 } })),
    images: [image("image_001", 1), image("image_002", 2)], output: { filename: null, aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" },
    artifacts: { audio_file: "/data/audio.wav", subtitle_file: "/data/final.srt", video_file: null }, voice_profile: "calm_female_06", attempts: 0,
    history: [{ at, stage: "subtitle_ready", message: "テスト準備" }], review: { required: false, reasons: [] }, error: null,
  };
}

(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-image-settings-test-"));
  const jobId = "job_20260714T140000Z_image_settings";
  const directory = path.join(root, jobId);
  fs.mkdirSync(path.join(directory, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(directory, "uploads", "image_001.png"), "original remains");
  fs.writeFileSync(path.join(directory, "job.json"), `${JSON.stringify(makeJob(jobId), null, 2)}\n`);
  try {
    const dto = getManualImageSettings(jobId, { root });
    assert.equal(JSON.stringify(dto).includes("stored_path"), false);
    assert.equal(dto.images.length, 2);
    const result = updateManualImageSettings(jobId, [
      { source_image_id: "image_002", segment_ids: ["seg_001"], requested_duration_seconds: 1 },
      { source_image_id: "image_001", segment_ids: ["seg_002"], requested_duration_seconds: 1 },
      { source_image_id: "image_001", segment_ids: ["seg_003"], requested_duration_seconds: 1 },
    ], { root, now: new Date("2026-07-14T14:00:01.000Z") });
    assert.equal(result.job.status, "images_ready");
    assert.equal(result.plan_mode, "explicit_segments_and_durations");
    assert.deepEqual(result.job.images.map((image) => image.order), [1, 2, 3]);
    assert.equal(new Set(result.job.images.map((image) => image.id)).size, 3);
    assert.deepEqual(result.job.images.map((image) => image.duration_seconds), [1, 1, 1]);
    assert.equal(fs.readFileSync(path.join(directory, "uploads", "image_001.png"), "utf8"), "original remains");
    execFileSync("python3", ["-c", [
      "import json,sys", "from jsonschema import Draft202012Validator,FormatChecker", "s=json.load(open(sys.argv[1]))", "j=json.load(open(sys.argv[2]))",
      "Draft202012Validator(s,format_checker=FormatChecker()).validate(j)",
    ].join(";"), path.join(__dirname, "..", "schemas", "manual-video-job.schema.json"), path.join(directory, "job.json")]);
    assert.throws(() => updateManualImageSettings(jobId, [{ source_image_id: "image_999", segment_ids: [], requested_duration_seconds: null }], { root }), (error) => error.code === "UNKNOWN_SOURCE_IMAGE");
    console.log("manual image settings tests: ok");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})();
