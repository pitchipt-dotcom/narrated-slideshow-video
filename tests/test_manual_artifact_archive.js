"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { archiveManualArtifacts } = require("../backend/manual-artifact-archive");

function createJob(root, id) {
  const directory = path.join(root, id); for (const name of ["uploads", "audio", "subtitles", "video"]) fs.mkdirSync(path.join(directory, name), { recursive: true });
  fs.writeFileSync(path.join(directory, "uploads", "image.png"), "image"); fs.writeFileSync(path.join(directory, "audio", "assembled.wav"), "audio"); fs.writeFileSync(path.join(directory, "subtitles", "final.srt"), "subtitle"); fs.writeFileSync(path.join(directory, "video", "result.mp4"), "video");
  const at = "2026-07-14T18:00:00Z";
  const job = { version: 2, mode: "manual", job_id: id, status: "video_ready", current_stage: "video_ready", created_at: at, updated_at: at,
    input: { title: "archive", subtitle_text: "表示台本", speech_text: "読み台本", request_note: "" },
    segments: [{ id: "seg_001", order: 1, subtitle_text: "表示", speech_text: "よみ", image_id: "image_001", requested_image_duration_seconds: null, audio: { status: "generated", path: `/data/${id}/audio/seg.wav`, duration_seconds: 1, error: null }, timing: { start_seconds: 0, end_seconds: 1 } }],
    images: [{ id: "image_001", source: "upload", order: 1, segment_ids: ["seg_001"], requested_duration_seconds: null, original_filename: "image.png", stored_filename: "image.png", stored_path: `/data/${id}/uploads/image.png`, sha256: "a".repeat(64), start_seconds: 0, end_seconds: 1, duration_seconds: 1, library_asset_id: null }],
    output: { filename: "result.mp4", aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" }, artifacts: { audio_file: `/data/${id}/audio/assembled.wav`, subtitle_file: `/data/${id}/subtitles/final.srt`, video_file: `/data/${id}/video/result.mp4` },
    voice_profile: "calm_female_06", attempts: 1, history: [{ at, stage: "video_ready", message: "動画完成" }], review: { required: false, reasons: [] }, error: null, regeneration: null, archive: null };
  fs.writeFileSync(path.join(directory, "job.json"), `${JSON.stringify(job, null, 2)}\n`); return directory;
}

(() => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "manual-artifact-archive-test-"));
  const source = path.join(temporary, "source"); const local = path.join(temporary, "local"); const nas = path.join(temporary, "nas"); fs.mkdirSync(source); fs.mkdirSync(nas);
  try {
    const savedId = "job_20260714T180000Z_archive_saved"; createJob(source, savedId);
    const saved = archiveManualArtifacts(savedId, { sourceRoot: source, localArchiveRoot: local, nasArchiveRoot: nas, now: new Date("2026-07-14T18:01:00Z") });
    assert.equal(saved.job.status, "completed"); assert.equal(saved.job.archive.status, "nas_saved"); assert(saved.nas_directory);
    for (const root of [saved.local_directory, saved.nas_directory]) {
      assert.equal(fs.readFileSync(path.join(root, "inputs", "subtitle_text.txt"), "utf8"), "表示台本\n"); assert(fs.existsSync(path.join(root, "metadata", "segments.json"))); assert(fs.existsSync(path.join(root, "video", "result.mp4")));
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.sha256.json"), "utf8")); assert(manifest.files.some((item) => item.path === "video/result.mp4")); assert(manifest.files.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
    }
    execFileSync("python3", ["-c", ["import json,sys", "from jsonschema import Draft202012Validator,FormatChecker", "s=json.load(open(sys.argv[1]))", "j=json.load(open(sys.argv[2]))", "Draft202012Validator(s,format_checker=FormatChecker()).validate(j)"].join(";"), path.join(__dirname, "..", "schemas", "manual-video-job.schema.json"), path.join(source, savedId, "job.json")]);

    const localId = "job_20260714T180100Z_archive_local"; createJob(source, localId);
    const localOnly = archiveManualArtifacts(localId, { sourceRoot: source, localArchiveRoot: local, nasArchiveRoot: path.join(temporary, "missing-nas"), now: new Date("2026-07-14T18:02:00Z") });
    assert.equal(localOnly.job.status, "video_ready"); assert.equal(localOnly.job.archive.status, "local_only"); assert.equal(localOnly.nas_directory, null); assert(fs.existsSync(path.join(localOnly.local_directory, "video", "result.mp4")));
    console.log("manual artifact archive tests: ok");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
})();
