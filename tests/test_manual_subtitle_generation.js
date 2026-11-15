"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { generateManualSubtitles, splitByLimit } = require("../backend/manual-subtitle-generation");

function writeSilentWav(file, durationSeconds) {
  const sampleRate = 48000;
  const samples = Math.round(sampleRate * durationSeconds);
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii"); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii"); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36, "ascii"); buffer.writeUInt32LE(dataBytes, 40);
  fs.writeFileSync(file, buffer);
}

function makeJob(jobId, logicalRoot, overlap = false) {
  const at = "2026-07-14T11:00:00.000Z";
  const longSubtitle = "これは長い字幕です。句読点を優先して一画面の文字数を制限し、スマートフォンでも読みやすい二行以内の字幕へ安全に分割します。最後まで表示します。";
  return {
    version: 2, mode: "manual", job_id: jobId, status: "audio_ready", current_stage: "audio_ready", created_at: at, updated_at: at,
    input: { title: "字幕", subtitle_text: `${longSubtitle}\n短い字幕。`, speech_text: "絶対に字幕へ出さない読み一。絶対に字幕へ出さない読み二。", request_note: "" },
    segments: [
      { id: "seg_001", order: 1, subtitle_text: longSubtitle, speech_text: "絶対に字幕へ出さない読み一。", image_id: null, requested_image_duration_seconds: null, audio: { status: "generated", path: `${logicalRoot}/${jobId}/audio/seg_001.wav`, duration_seconds: 8, error: null }, timing: { start_seconds: 0, end_seconds: 8 } },
      { id: "seg_002", order: 2, subtitle_text: "短い字幕。", speech_text: "絶対に字幕へ出さない読み二。", image_id: null, requested_image_duration_seconds: null, audio: { status: "generated", path: `${logicalRoot}/${jobId}/audio/seg_002.wav`, duration_seconds: 1, error: null }, timing: { start_seconds: overlap ? 7.9 : 8, end_seconds: 9 } },
    ],
    images: [{ id: "image_001", source: "upload", order: 1, segment_ids: [], requested_duration_seconds: null, original_filename: "test.png", stored_filename: "image_001.png", stored_path: `${logicalRoot}/${jobId}/uploads/image_001.png`, sha256: "a".repeat(64) }],
    output: { filename: null, aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" },
    artifacts: { audio_file: `${logicalRoot}/${jobId}/audio/assembled.wav`, subtitle_file: null, video_file: null }, voice_profile: "calm_female_06", attempts: 0,
    history: [{ at, stage: "audio_ready", message: "テスト準備" }], review: { required: false, reasons: [] }, error: null,
  };
}

(() => {
  assert.throws(() => splitByLimit("   ", 48), (error) => error.code === "EMPTY_SUBTITLE");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-subtitle-test-"));
  const logicalRoot = "/data/test/manual_jobs";
  try {
    const jobId = "job_20260714T110000Z_subtitle_test";
    const jobDirectory = path.join(root, jobId);
    for (const name of ["audio", "subtitles", "uploads"]) fs.mkdirSync(path.join(jobDirectory, name), { recursive: true });
    writeSilentWav(path.join(jobDirectory, "audio", "assembled.wav"), 9);
    fs.writeFileSync(path.join(jobDirectory, "job.json"), `${JSON.stringify(makeJob(jobId, logicalRoot), null, 2)}\n`);
    const result = generateManualSubtitles(jobId, { root, logicalRoot, now: new Date("2026-07-14T11:00:01.000Z") });
    assert.equal(result.reused, false);
    assert(result.cue_count >= 3);
    assert.equal(result.job.status, "subtitle_ready");
    const subtitleFile = path.join(jobDirectory, "subtitles", "final.srt");
    const srt = fs.readFileSync(subtitleFile, "utf8");
    assert.equal(srt.includes("絶対に字幕へ出さない"), false);
    assert.equal(srt.includes("短い字幕。"), true);
    const blocks = srt.trim().split("\n\n");
    let previousEnd = -1;
    for (const block of blocks) {
      const lines = block.split("\n");
      const [start, end] = lines[1].split(" --> ").map((value) => {
        const match = value.match(/^(\d+):(\d+):(\d+),(\d+)$/);
        return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]));
      });
      assert(start >= previousEnd);
      assert(end - start >= 1200 && end <= 9000);
      previousEnd = end;
      const displayLines = lines.slice(2);
      assert(displayLines.length <= 2);
      assert(displayLines.every((line) => Array.from(line).length <= 20));
      assert(displayLines.reduce((sum, line) => sum + Array.from(line).length, 0) <= 40);
    }
    assert.equal(fs.existsSync(path.join(jobDirectory, "subtitles", "reflow-log.json")), true);
    execFileSync("python3", ["-c", [
      "import json,sys", "from jsonschema import Draft202012Validator,FormatChecker",
      "s=json.load(open(sys.argv[1],encoding='utf-8'))", "j=json.load(open(sys.argv[2],encoding='utf-8'))",
      "Draft202012Validator(s,format_checker=FormatChecker()).validate(j)",
    ].join(";"), path.join(__dirname, "..", "schemas", "manual-video-job.schema.json"), path.join(jobDirectory, "job.json")]);
    const reused = generateManualSubtitles(jobId, { root, logicalRoot });
    assert.equal(reused.reused, true);

    const overlapId = "job_20260714T110100Z_overlap_test";
    const overlapDirectory = path.join(root, overlapId);
    for (const name of ["audio", "subtitles", "uploads"]) fs.mkdirSync(path.join(overlapDirectory, name), { recursive: true });
    writeSilentWav(path.join(overlapDirectory, "audio", "assembled.wav"), 9);
    fs.writeFileSync(path.join(overlapDirectory, "job.json"), `${JSON.stringify(makeJob(overlapId, logicalRoot, true), null, 2)}\n`);
    assert.throws(() => generateManualSubtitles(overlapId, { root, logicalRoot }), (error) => error.code === "SUBTITLE_OVERLAP");
    assert.equal(fs.existsSync(path.join(overlapDirectory, "subtitles", "final.srt")), false);
    console.log("manual subtitle generation tests: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
