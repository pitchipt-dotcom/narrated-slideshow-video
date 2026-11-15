"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { regenerateManualJob } = require("../backend/manual-job-regeneration");

function hashTree(directory) {
  const hash = crypto.createHash("sha256");
  for (const file of fs.readdirSync(directory, { recursive: true }).sort()) { const target = path.join(directory, file); if (fs.statSync(target).isFile()) hash.update(file).update(fs.readFileSync(target)); }
  return hash.digest("hex");
}

(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-regeneration-test-"));
  const sourceId = "job_20260714T170000Z_regen_source"; const logicalRoot = "/data/manual_jobs"; const sourceDir = path.join(root, sourceId);
  for (const name of ["uploads", "audio", "subtitles", "video"]) fs.mkdirSync(path.join(sourceDir, name), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "uploads", "image_001.png"), "image"); fs.writeFileSync(path.join(sourceDir, "audio", "seg_001.wav"), "segment"); fs.writeFileSync(path.join(sourceDir, "audio", "assembled.wav"), "assembled"); fs.writeFileSync(path.join(sourceDir, "subtitles", "final.srt"), "subtitle"); fs.writeFileSync(path.join(sourceDir, "video", "old.mp4"), "old-video");
  const at = "2026-07-14T17:00:00Z";
  const source = { version: 2, mode: "manual", job_id: sourceId, status: "video_ready", current_stage: "video_ready", created_at: at, updated_at: at,
    input: { title: "再生成", subtitle_text: "表示", speech_text: "よみ", request_note: "" },
    segments: [{ id: "seg_001", order: 1, subtitle_text: "表示", speech_text: "よみ", image_id: "image_001", requested_image_duration_seconds: null, audio: { status: "generated", path: `${logicalRoot}/${sourceId}/audio/seg_001.wav`, duration_seconds: 1, error: null }, timing: { start_seconds: 0, end_seconds: 1 } }],
    images: [{ id: "image_001", source: "upload", order: 1, segment_ids: ["seg_001"], requested_duration_seconds: null, original_filename: "image.png", stored_filename: "image_001.png", stored_path: `${logicalRoot}/${sourceId}/uploads/image_001.png`, sha256: "a".repeat(64), start_seconds: 0, end_seconds: 1, duration_seconds: 1, library_asset_id: null }],
    output: { filename: "old.mp4", aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" }, artifacts: { audio_file: `${logicalRoot}/${sourceId}/audio/assembled.wav`, subtitle_file: `${logicalRoot}/${sourceId}/subtitles/final.srt`, video_file: `${logicalRoot}/${sourceId}/video/old.mp4` },
    voice_profile: "calm_female_06", attempts: 1, history: [{ at, stage: "video_ready", message: "完了" }], review: { required: false, reasons: [] }, error: null, regeneration: null };
  fs.writeFileSync(path.join(sourceDir, "job.json"), `${JSON.stringify(source, null, 2)}\n`);
  const before = hashTree(sourceDir);
  try {
    const regenerated = regenerateManualJob(sourceId, { root, logicalRoot, now: new Date("2026-07-14T17:10:00Z") });
    assert.notEqual(regenerated.job_id, sourceId); assert.equal(regenerated.status, "images_ready"); assert.equal(regenerated.regeneration.source_job_id, sourceId);
    assert.equal(regenerated.artifacts.video_file, null); assert(regenerated.artifacts.audio_file.includes(regenerated.job_id)); assert(regenerated.segments[0].audio.path.includes(regenerated.job_id)); assert(regenerated.images[0].stored_path.includes(regenerated.job_id));
    const target = path.join(root, regenerated.job_id); assert.equal(fs.readFileSync(path.join(target, "uploads", "image_001.png"), "utf8"), "image"); assert.equal(fs.readFileSync(path.join(target, "audio", "assembled.wav"), "utf8"), "assembled"); assert.equal(fs.readFileSync(path.join(target, "subtitles", "final.srt"), "utf8"), "subtitle"); assert.equal(fs.readdirSync(path.join(target, "video")).length, 0);
    assert.equal(hashTree(sourceDir), before);
    execFileSync("python3", ["-c", ["import json,sys", "from jsonschema import Draft202012Validator,FormatChecker", "s=json.load(open(sys.argv[1]))", "j=json.load(open(sys.argv[2]))", "Draft202012Validator(s,format_checker=FormatChecker()).validate(j)"].join(";"), path.join(__dirname, "..", "schemas", "manual-video-job.schema.json"), path.join(target, "job.json")]);

    source.audio_quality = {
      version: 1, status: "attention", checked_at: at, f0_is_diagnostic_alone: false,
      baselines: {}, segments: [], anomalies: [{ segment_id: "seg_001", reasons: ["VERY_LOW_LEVEL"], metrics: {} }],
      regeneration_count: 0, max_regenerations: 2,
    };
    fs.writeFileSync(path.join(sourceDir, "job.json"), `${JSON.stringify(source, null, 2)}\n`);
    const partial = regenerateManualJob(sourceId, { root, logicalRoot, now: new Date("2026-07-14T17:20:00Z") });
    const partialDirectory = path.join(root, partial.job_id);
    assert.equal(partial.status, "audio_generating");
    assert.equal(partial.regeneration.kind, "anomalous_audio_segments");
    assert.deepEqual(partial.regeneration.segment_ids, ["seg_001"]);
    assert.equal(partial.regeneration.audio_quality_regeneration_count, 1);
    assert.equal(partial.segments[0].audio.status, "pending");
    assert.equal(partial.artifacts.audio_file, null);
    assert.equal(partial.artifacts.subtitle_file, null);
    assert.equal(partial.output.filename, null);
    assert.equal(partial.audio_quality, null);
    assert.equal(fs.existsSync(path.join(partialDirectory, "audio", "seg_001.wav")), false);
    assert.equal(fs.existsSync(path.join(partialDirectory, "audio", "assembled.wav")), false);
    assert.equal(fs.existsSync(path.join(partialDirectory, "subtitles", "final.srt")), false);
    assert.equal(fs.readFileSync(path.join(partialDirectory, "uploads", "image_001.png"), "utf8"), "image");
    execFileSync("python3", ["-c", ["import json,sys", "from jsonschema import Draft202012Validator,FormatChecker", "s=json.load(open(sys.argv[1]))", "j=json.load(open(sys.argv[2]))", "Draft202012Validator(s,format_checker=FormatChecker()).validate(j)"].join(";"), path.join(__dirname, "..", "schemas", "manual-video-job.schema.json"), path.join(partialDirectory, "job.json")]);

    const blockSourceId = "job_20260714T173000Z_block_regen";
    const blockSourceDir = path.join(root, blockSourceId);
    fs.cpSync(sourceDir, blockSourceDir, { recursive: true });
    const blockSource = structuredClone(source);
    blockSource.job_id = blockSourceId;
    blockSource.segments[0].audio = { status: "pending", path: null, duration_seconds: null, error: null };
    blockSource.segments[0].audio_block_index = 0;
    blockSource.audio_blocks = [{
      id: "block_000", audio_block_index: 0, subtitle_segment_indexes: [0], segment_ids: ["seg_001"], text: "よみ",
      readable_characters: 2, sentence_count: 1, audio_path: `${logicalRoot}/${blockSourceId}/audio/block_000.wav`,
      status: "completed", duration_seconds: 1, seed: 123, started_at: at, completed_at: at, error: null, retry_count: 0,
    }];
    blockSource.artifacts.audio_file = `${logicalRoot}/${blockSourceId}/audio/assembled.wav`;
    blockSource.artifacts.subtitle_file = `${logicalRoot}/${blockSourceId}/subtitles/final.srt`;
    blockSource.audio_quality = {
      version: 2, unit: "audio_block", status: "attention", checked_at: at, f0_is_diagnostic_alone: false,
      baselines: {}, audio_blocks: [], anomalies: [{ audio_block_id: "block_000", segment_ids: ["seg_001"], reasons: ["VERY_LOW_LEVEL"], metrics: {} }],
      regeneration_count: 0, max_regenerations: 2,
    };
    fs.writeFileSync(path.join(blockSourceDir, "audio", "block_000.wav"), "block");
    fs.writeFileSync(path.join(blockSourceDir, "job.json"), `${JSON.stringify(blockSource, null, 2)}\n`);
    const blockPartial = regenerateManualJob(blockSourceId, { root, logicalRoot, now: new Date("2026-07-14T17:40:00Z") });
    const blockPartialDirectory = path.join(root, blockPartial.job_id);
    assert.equal(blockPartial.regeneration.kind, "anomalous_audio_blocks");
    assert.deepEqual(blockPartial.regeneration.audio_block_ids, ["block_000"]);
    assert.equal(blockPartial.audio_blocks[0].status, "pending");
    assert.equal(fs.existsSync(path.join(blockPartialDirectory, "audio", "block_000.wav")), false);
    execFileSync("python3", ["-c", ["import json,sys", "from jsonschema import Draft202012Validator,FormatChecker", "s=json.load(open(sys.argv[1]))", "j=json.load(open(sys.argv[2]))", "Draft202012Validator(s,format_checker=FormatChecker()).validate(j)"].join(";"), path.join(__dirname, "..", "schemas", "manual-video-job.schema.json"), path.join(blockPartialDirectory, "job.json")]);
    console.log("manual job regeneration tests: ok");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})();
