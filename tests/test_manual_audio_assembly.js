"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { assembleManualAudio, probeDuration } = require("../backend/manual-audio-assembly");

function generateTone(file, frequency, duration) {
  execFileSync("ffmpeg", [
    "-v", "error", "-n", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`,
    "-c:a", "pcm_s16le", "-ac", "1", file,
  ]);
}

function segment(id, order, logicalRoot, jobId) {
  return {
    id, order, subtitle_text: `表示${order}`, speech_text: `よみ${order}`, image_id: null,
    requested_image_duration_seconds: null,
    audio: { status: "generated", path: `${logicalRoot}/${jobId}/audio/${id}.wav`, duration_seconds: null, error: null },
    timing: { start_seconds: null, end_seconds: null },
  };
}

function makeJob(jobId, logicalRoot) {
  const at = "2026-07-14T10:00:00.000Z";
  return {
    version: 2, mode: "manual", job_id: jobId, status: "audio_ready", current_stage: "audio_ready",
    created_at: at, updated_at: at,
    input: { title: "音声連結", subtitle_text: "表示1。表示2。", speech_text: "よみ1。よみ2。", request_note: "" },
    segments: [segment("seg_002", 2, logicalRoot, jobId), segment("seg_001", 1, logicalRoot, jobId)],
    images: [{
      id: "image_001", source: "upload", order: 1, segment_ids: [], requested_duration_seconds: null,
      original_filename: "test.png", stored_filename: "image_001.png",
      stored_path: `${logicalRoot}/${jobId}/uploads/image_001.png`, sha256: "a".repeat(64),
    }],
    output: { filename: null, aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" },
    artifacts: { audio_file: null, subtitle_file: null, video_file: null }, voice_profile: "calm_female_06", attempts: 0,
    history: [{ at, stage: "audio_ready", message: "テスト準備" }], review: { required: false, reasons: [] }, error: null,
  };
}

(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-audio-assembly-test-"));
  const logicalRoot = "/data/test/manual_jobs";
  const profilePath = path.join(root, "voice_profiles.json");
  fs.writeFileSync(profilePath, `${JSON.stringify({ profiles: { calm_female_06: { tempo: 1.25 } } })}\n`);
  try {
    const jobId = "job_20260714T100000Z_assembly_test";
    const jobDirectory = path.join(root, jobId);
    const audioDirectory = path.join(jobDirectory, "audio");
    fs.mkdirSync(audioDirectory, { recursive: true });
    fs.writeFileSync(path.join(jobDirectory, "job.json"), `${JSON.stringify(makeJob(jobId, logicalRoot), null, 2)}\n`);
    generateTone(path.join(audioDirectory, "seg_001.wav"), 440, 0.25);
    generateTone(path.join(audioDirectory, "seg_002.wav"), 660, 0.375);

    const result = assembleManualAudio(jobId, {
      root, logicalRoot, voiceProfilesPath: profilePath, gapSeconds: 0.1,
      now: new Date("2026-07-14T10:00:01.000Z"),
    });
    assert.equal(result.reused, false);
    assert.equal(result.tempo, 1.25);
    assert.equal(result.gap_seconds, 0.1);
    assert.equal(result.job.artifacts.audio_file, `${logicalRoot}/${jobId}/audio/assembled.wav`);
    const first = result.job.segments.find((item) => item.id === "seg_001");
    const second = result.job.segments.find((item) => item.id === "seg_002");
    assert(first.audio.duration_seconds > 0.15 && first.audio.duration_seconds < 0.24);
    assert(second.audio.duration_seconds > 0.25 && second.audio.duration_seconds < 0.34);
    assert.equal(first.timing.start_seconds, 0);
    assert(Math.abs(second.timing.start_seconds - (first.timing.end_seconds + 0.1)) < 0.000001);
    assert(second.timing.end_seconds > second.timing.start_seconds);
    const outputFile = path.join(audioDirectory, "assembled.wav");
    assert.equal(fs.existsSync(outputFile), true);
    assert(Math.abs(probeDuration(outputFile) - second.timing.end_seconds) < 0.05);
    assert.equal(fs.readdirSync(audioDirectory).some((name) => name.startsWith(".tmp-assembly-") || name === ".assemble.lock"), false);
    execFileSync("python3", ["-c", [
      "import json,sys",
      "from jsonschema import Draft202012Validator,FormatChecker",
      "schema=json.load(open(sys.argv[1],encoding='utf-8'))",
      "job=json.load(open(sys.argv[2],encoding='utf-8'))",
      "Draft202012Validator(schema,format_checker=FormatChecker()).validate(job)",
    ].join(";"), path.join(__dirname, "..", "schemas", "manual-video-job.schema.json"), path.join(jobDirectory, "job.json")]);

    const reused = assembleManualAudio(jobId, { root, logicalRoot, voiceProfilesPath: profilePath });
    assert.equal(reused.reused, true);

    const missingJobId = "job_20260714T100100Z_missing_test";
    const missingDirectory = path.join(root, missingJobId);
    fs.mkdirSync(path.join(missingDirectory, "audio"), { recursive: true });
    fs.writeFileSync(path.join(missingDirectory, "job.json"), `${JSON.stringify(makeJob(missingJobId, logicalRoot), null, 2)}\n`);
    generateTone(path.join(missingDirectory, "audio", "seg_001.wav"), 440, 0.1);
    assert.throws(
      () => assembleManualAudio(missingJobId, { root, logicalRoot, voiceProfilesPath: profilePath }),
      (error) => error.code === "AUDIO_FILE_MISSING",
    );
    assert.equal(fs.existsSync(path.join(missingDirectory, "audio", "assembled.wav")), false);

    const emptyJobId = "job_20260714T100200Z_empty_test";
    const emptyDirectory = path.join(root, emptyJobId);
    fs.mkdirSync(path.join(emptyDirectory, "audio"), { recursive: true });
    fs.writeFileSync(path.join(emptyDirectory, "job.json"), `${JSON.stringify(makeJob(emptyJobId, logicalRoot), null, 2)}\n`);
    fs.writeFileSync(path.join(emptyDirectory, "audio", "seg_001.wav"), Buffer.alloc(44));
    generateTone(path.join(emptyDirectory, "audio", "seg_002.wav"), 660, 0.1);
    assert.throws(
      () => assembleManualAudio(emptyJobId, { root, logicalRoot, voiceProfilesPath: profilePath }),
      (error) => error.code === "AUDIO_FILE_EMPTY",
    );
    assert.equal(fs.existsSync(path.join(emptyDirectory, "audio", "assembled.wav")), false);
    console.log("manual audio assembly tests: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
