"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { applyImageTiming, planAndSaveManualImages } = require("../backend/manual-image-timing");

function image(id, order) {
  return { id, source: "upload", order, segment_ids: [], requested_duration_seconds: null, original_filename: `${id}.png`, stored_filename: `${id}.png`, stored_path: `/data/test/${id}.png`, sha256: String(order).repeat(64), start_seconds: null, end_seconds: null, duration_seconds: null };
}

function makeJob(jobId, imageCount = 2, segmentCount = 3) {
  const at = "2026-07-14T12:00:00.000Z";
  const segments = Array.from({ length: segmentCount }, (_, index) => ({
    id: `seg_${String(index + 1).padStart(3, "0")}`, order: index + 1, subtitle_text: `表示${index + 1}`, speech_text: `よみ${index + 1}`,
    image_id: null, requested_image_duration_seconds: null,
    audio: { status: "generated", path: `/data/test/seg_${String(index + 1).padStart(3, "0")}.wav`, duration_seconds: 1, error: null },
    timing: { start_seconds: index, end_seconds: index + 1 },
  }));
  return {
    version: 2, mode: "manual", job_id: jobId, status: "subtitle_ready", current_stage: "subtitle_ready", created_at: at, updated_at: at,
    input: { title: "画像時間", subtitle_text: "表示", speech_text: "よみ", request_note: "" }, segments,
    images: Array.from({ length: imageCount }, (_, index) => image(`image_${String(index + 1).padStart(3, "0")}`, index + 1)),
    output: { filename: null, aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" },
    artifacts: { audio_file: "/data/test/assembled.wav", subtitle_file: "/data/test/final.srt", video_file: null }, voice_profile: "calm_female_06", attempts: 0,
    history: [{ at, stage: "subtitle_ready", message: "テスト準備" }], review: { required: false, reasons: [] }, error: null,
  };
}

(() => {
  const grouped = applyImageTiming(makeJob("job_grouped"));
  assert.equal(grouped.mode, "automatic_segments");
  assert.deepEqual(grouped.job.images[0].segment_ids, ["seg_001"]);
  assert.deepEqual(grouped.job.images[1].segment_ids, ["seg_002", "seg_003"]);
  assert.deepEqual(grouped.job.images.map((item) => [item.start_seconds, item.end_seconds, item.duration_seconds]), [[0, 1, 1], [1, 3, 2]]);
  assert.deepEqual(grouped.job.segments.map((item) => item.image_id), ["image_001", "image_002", "image_002"]);

  const uniform = applyImageTiming(makeJob("job_uniform", 4, 2));
  assert.equal(uniform.mode, "equal_duration");
  assert.deepEqual(uniform.job.images.map((item) => item.duration_seconds), [0.5, 0.5, 0.5, 0.5]);
  assert.equal(uniform.job.images[0].start_seconds, 0);
  assert.equal(uniform.job.images.at(-1).end_seconds, 2);
  assert(uniform.job.images.every((item) => item.segment_ids.length >= 1));

  const requested = makeJob("job_requested", 2, 3);
  requested.images[0].requested_duration_seconds = 1.25;
  requested.images[1].requested_duration_seconds = 1.75;
  const requestedResult = applyImageTiming(requested);
  assert.equal(requestedResult.mode, "requested_durations");
  assert.deepEqual(requestedResult.job.images.map((item) => item.duration_seconds), [1.25, 1.75]);

  const partial = makeJob("job_partial");
  partial.images[0].segment_ids = ["seg_001"];
  assert.throws(() => applyImageTiming(partial), (error) => error.code === "PARTIAL_SEGMENT_ASSIGNMENT");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-image-timing-test-"));
  const jobId = "job_20260714T120000Z_image_timing";
  const directory = path.join(root, jobId);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "job.json"), `${JSON.stringify(makeJob(jobId), null, 2)}\n`);
  try {
    const saved = planAndSaveManualImages(jobId, { root, now: new Date("2026-07-14T12:00:01.000Z") });
    assert.equal(saved.job.status, "images_ready");
    execFileSync("python3", ["-c", [
      "import json,sys", "from jsonschema import Draft202012Validator,FormatChecker",
      "s=json.load(open(sys.argv[1],encoding='utf-8'))", "j=json.load(open(sys.argv[2],encoding='utf-8'))",
      "Draft202012Validator(s,format_checker=FormatChecker()).validate(j)",
    ].join(";"), path.join(__dirname, "..", "schemas", "manual-video-job.schema.json"), path.join(directory, "job.json")]);
    const reused = planAndSaveManualImages(jobId, { root });
    assert.equal(reused.reused, true);
    console.log("manual image timing tests: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
