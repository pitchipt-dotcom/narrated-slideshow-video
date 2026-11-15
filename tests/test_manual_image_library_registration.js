"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { registerManualImage } = require("../backend/manual-image-library-registration");

function png256() {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8); buffer.write("IHDR", 12, "ascii"); buffer.writeUInt32BE(256, 16); buffer.writeUInt32BE(256, 20);
  return buffer;
}

function makeJob(jobId, bytes) {
  const at = "2026-07-14T13:00:00.000Z";
  return {
    version: 2, mode: "manual", job_id: jobId, status: "images_ready", current_stage: "images_ready", created_at: at, updated_at: at,
    input: { title: "ライブラリ登録テスト", subtitle_text: "表示", speech_text: "よみ", request_note: "" },
    segments: [{ id: "seg_001", order: 1, subtitle_text: "表示", speech_text: "よみ", image_id: "image_001", requested_image_duration_seconds: null, audio: { status: "generated", path: "/data/test/seg.wav", duration_seconds: 1, error: null }, timing: { start_seconds: 0, end_seconds: 1 } }],
    images: [{ id: "image_001", source: "upload", order: 1, segment_ids: ["seg_001"], requested_duration_seconds: null, original_filename: "元画像.png", stored_filename: "image_001.png", stored_path: `/data/test/${jobId}/uploads/image_001.png`, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), start_seconds: 0, end_seconds: 1, duration_seconds: 1, library_asset_id: null }],
    output: { filename: null, aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" }, artifacts: { audio_file: "/data/test/audio.wav", subtitle_file: "/data/test/final.srt", video_file: null },
    voice_profile: "calm_female_06", attempts: 0, history: [{ at, stage: "images_ready", message: "テスト準備" }], review: { required: false, reasons: [] }, error: null,
  };
}

function saveJob(root, job, bytes) {
  const directory = path.join(root, job.job_id);
  fs.mkdirSync(path.join(directory, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(directory, "uploads", "image_001.png"), bytes);
  fs.writeFileSync(path.join(directory, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
}

(() => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "manual-image-library-test-"));
  const jobRoot = path.join(temporary, "jobs");
  const libraryRoot = path.join(temporary, "library");
  fs.mkdirSync(jobRoot); fs.mkdirSync(path.join(libraryRoot, "metadata", "review"), { recursive: true });
  fs.mkdirSync(path.join(libraryRoot, "generated", "review"), { recursive: true });
  const bytes = png256();
  const rights = { source_type: "owned", license: "owner-confirmed", commercial_use: true, attribution_required: false };
  try {
    const firstId = "job_20260714T130000Z_library_one";
    saveJob(jobRoot, makeJob(firstId, bytes), bytes);
    const first = registerManualImage(firstId, "image_001", { jobRoot, libraryRoot, rights, tags: ["test_asset"], now: new Date("2026-07-14T13:00:01.000Z") });
    assert.equal(first.duplicate, false);
    assert.equal(first.metadata.search.enabled, true);
    assert.equal(first.metadata.quality.status, "pending");
    assert.equal(first.metadata.review.status, "pending");
    assert.equal(first.metadata.usage.reuse_count, 1);
    assert(first.metadata.content.description.includes("元画像.png"));
    assert.equal(fs.existsSync(path.join(jobRoot, firstId, "uploads", "image_001.png")), true);
    const candidate = path.join(libraryRoot, first.metadata.file.relative_path);
    assert.equal(fs.existsSync(candidate), true);
    const metadataFile = path.join(libraryRoot, "metadata", "review", `${first.asset_id}.json`);
    const secondId = "job_20260714T130100Z_library_two";
    saveJob(jobRoot, makeJob(secondId, bytes), bytes);
    const second = registerManualImage(secondId, "image_001", { jobRoot, libraryRoot, rights, now: new Date("2026-07-14T13:00:02.000Z") });
    assert.equal(second.duplicate, true);
    assert.equal(second.asset_id, first.asset_id);
    assert.equal(second.metadata.usage.reuse_count, 2);
    assert.deepEqual(second.metadata.usage.recent_video_ids, [secondId, firstId]);
    assert.equal(fs.readdirSync(path.join(libraryRoot, "generated", "review")).length, 1);

    const reused = registerManualImage(firstId, "image_001", { jobRoot, libraryRoot, rights });
    assert.equal(reused.reused, true);
    const unchanged = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    assert.equal(unchanged.usage.reuse_count, 2);

    const thirdId = "job_20260714T130200Z_rights_required";
    const otherBytes = Buffer.from(bytes); otherBytes[32] = 1;
    saveJob(jobRoot, makeJob(thirdId, otherBytes), otherBytes);
    assert.throws(() => registerManualImage(thirdId, "image_001", { jobRoot, libraryRoot }), (error) => error.code === "RIGHTS_CONFIRMATION_REQUIRED");
    assert.equal(fs.readdirSync(path.join(libraryRoot, "generated", "review")).length, 1);

    execFileSync("python3", ["-c", [
      "import json,sys", "from jsonschema import Draft202012Validator,FormatChecker",
      "s=json.load(open(sys.argv[1],encoding='utf-8'))", "j=json.load(open(sys.argv[2],encoding='utf-8'))",
      "Draft202012Validator(s,format_checker=FormatChecker()).validate(j)",
    ].join(";"), path.join(__dirname, "..", "schemas", "manual-video-job.schema.json"), path.join(jobRoot, firstId, "job.json")]);
    console.log("manual image library registration tests: ok");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})();
