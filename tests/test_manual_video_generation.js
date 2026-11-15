"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { generateManualVideo, mediaMismatches } = require("../backend/manual-video-generation");

function silentWav(file, seconds) {
  const rate = 48000; const samples = Math.round(rate * seconds); const bytes = samples * 2; const buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + bytes, 4); buffer.write("WAVEfmt ", 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(bytes, 40); fs.writeFileSync(file, buffer);
}

function makeJob(jobId, logicalRoot) {
  const at = "2026-07-14T15:00:00.000Z";
  return {
    version: 2, mode: "manual", job_id: jobId, status: "images_ready", current_stage: "images_ready", created_at: at, updated_at: at,
    input: { title: "動画テスト", subtitle_text: "赤。青。", speech_text: "あか。あお。", request_note: "" },
    segments: [
      { id: "seg_001", order: 1, subtitle_text: "赤", speech_text: "あか", image_id: "image_001", requested_image_duration_seconds: null, audio: { status: "generated", path: `${logicalRoot}/${jobId}/audio/seg_001.wav`, duration_seconds: 0.5, error: null }, timing: { start_seconds: 0, end_seconds: 0.5 } },
      { id: "seg_002", order: 2, subtitle_text: "青", speech_text: "あお", image_id: "image_002", requested_image_duration_seconds: null, audio: { status: "generated", path: `${logicalRoot}/${jobId}/audio/seg_002.wav`, duration_seconds: 0.5, error: null }, timing: { start_seconds: 0.5, end_seconds: 1 } },
    ],
    images: [
      { id: "image_001", source: "upload", order: 1, segment_ids: ["seg_001"], requested_duration_seconds: null, original_filename: "red.png", stored_filename: "image_001.png", stored_path: `${logicalRoot}/${jobId}/uploads/image_001.png`, sha256: "a".repeat(64), start_seconds: 0, end_seconds: 0.5, duration_seconds: 0.5, library_asset_id: null },
      { id: "image_002", source: "upload", order: 2, segment_ids: ["seg_002"], requested_duration_seconds: null, original_filename: "blue.png", stored_filename: "image_002.png", stored_path: `${logicalRoot}/${jobId}/uploads/image_002.png`, sha256: "b".repeat(64), start_seconds: 0.5, end_seconds: 1, duration_seconds: 0.5, library_asset_id: null },
    ],
    output: { filename: "manual-test.mp4", aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" },
    artifacts: { audio_file: `${logicalRoot}/${jobId}/audio/assembled.wav`, subtitle_file: `${logicalRoot}/${jobId}/subtitles/final.srt`, video_file: null },
    voice_profile: "calm_female_06", attempts: 0, history: [{ at, stage: "images_ready", message: "テスト準備" }], review: { required: false, reasons: [] }, error: null,
  };
}

function pixel(file, seconds) {
  return execFileSync("ffmpeg", ["-v", "error", "-ss", String(seconds), "-i", file, "-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: null });
}

(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-video-generation-test-"));
  const logicalRoot = "/data/manual_jobs";
  try {
    const jobId = "job_20260714T150000Z_video_test"; const directory = path.join(root, jobId);
    for (const name of ["uploads", "audio", "subtitles", "video"]) fs.mkdirSync(path.join(directory, name), { recursive: true });
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360", "-frames:v", "1", path.join(directory, "uploads", "image_001.png")]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=360x640", "-frames:v", "1", path.join(directory, "uploads", "image_002.png")]);
    silentWav(path.join(directory, "audio", "assembled.wav"), 1);
    fs.writeFileSync(path.join(directory, "subtitles", "final.srt"), "1\n00:00:00,000 --> 00:00:00,500\n赤\n\n2\n00:00:00,500 --> 00:00:01,000\n青\n");
    fs.writeFileSync(path.join(directory, "job.json"), `${JSON.stringify(makeJob(jobId, logicalRoot), null, 2)}\n`);
    let tick = 1;
    const result = generateManualVideo(jobId, { root, logicalRoot, pathMappings: [{ logicalRoot, hostRoot: root }], now: () => new Date(`2026-07-14T15:00:0${tick++}.000Z`) });
    assert.equal(result.reused, false); assert.equal(result.job.status, "video_ready");
    assert.deepEqual([result.media.video_codec, result.media.audio_codec, result.media.width, result.media.height, result.media.fps, result.media.pix_fmt], ["h264", "aac", 768, 512, 30, "yuv420p"]);
    assert(Math.abs(result.media.duration_seconds - 1) < 0.1);
    assert(Math.abs(result.media.video_duration_seconds - 1) < 0.1);
    assert(Math.abs(result.media.audio_duration_seconds - 1) < 0.1);
    const output = path.join(directory, "video", "manual-test.mp4");
    const first = pixel(output, 0.2); const second = pixel(output, 0.7);
    assert(first[0] > first[2]); assert(second[2] > second[0]);
    const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", output], { encoding: "utf8" }));
    assert.deepEqual(streams.streams.map((stream) => stream.codec_type).sort(), ["audio", "video"]);
    execFileSync("python3", ["-c", ["import json,sys", "from jsonschema import Draft202012Validator,FormatChecker", "s=json.load(open(sys.argv[1]))", "j=json.load(open(sys.argv[2]))", "Draft202012Validator(s,format_checker=FormatChecker()).validate(j)"].join(";"), path.join(__dirname, "..", "schemas", "manual-video-job.schema.json"), path.join(directory, "job.json")]);
    const reused = generateManualVideo(jobId, { root, logicalRoot, pathMappings: [{ logicalRoot, hostRoot: root }] }); assert.equal(reused.reused, true);

    const singleId = "job_20260714T150050Z_video_single"; const singleDirectory = path.join(root, singleId);
    for (const name of ["uploads", "audio", "subtitles", "video"]) fs.mkdirSync(path.join(singleDirectory, name), { recursive: true });
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=768x512", "-frames:v", "1", path.join(singleDirectory, "uploads", "image_001.png")]);
    silentWav(path.join(singleDirectory, "audio", "assembled.wav"), 1);
    fs.writeFileSync(path.join(singleDirectory, "subtitles", "final.srt"), "1\n00:00:00,000 --> 00:00:01,000\n緑\n");
    const singleJob = makeJob(singleId, logicalRoot); singleJob.segments = [singleJob.segments[0]]; singleJob.segments[0].audio.duration_seconds = 1; singleJob.segments[0].timing.end_seconds = 1;
    singleJob.images = [singleJob.images[0]]; singleJob.images[0].segment_ids = ["seg_001"]; singleJob.images[0].end_seconds = 1; singleJob.images[0].duration_seconds = 1; singleJob.output.filename = "single.mp4";
    fs.writeFileSync(path.join(singleDirectory, "job.json"), `${JSON.stringify(singleJob, null, 2)}\n`);
    const single = generateManualVideo(singleId, { root, logicalRoot, pathMappings: [{ logicalRoot, hostRoot: root }], now: () => new Date(`2026-07-14T15:00:0${tick++}.000Z`) });
    assert.equal(single.job.status, "video_ready"); assert(Math.abs(single.media.duration_seconds - 1) < 0.1);

    const sparseId = "job_20260714T150075Z_video_sparse"; const sparseDirectory = path.join(root, sparseId);
    for (const name of ["uploads", "audio", "subtitles", "video"]) fs.mkdirSync(path.join(sparseDirectory, name), { recursive: true });
    fs.copyFileSync(path.join(directory, "uploads", "image_001.png"), path.join(sparseDirectory, "uploads", "image_001.png"));
    fs.copyFileSync(path.join(directory, "uploads", "image_002.png"), path.join(sparseDirectory, "uploads", "image_002.png"));
    silentWav(path.join(sparseDirectory, "audio", "assembled.wav"), 24);
    fs.writeFileSync(path.join(sparseDirectory, "subtitles", "final.srt"), "1\n00:00:00,000 --> 00:00:24,000\n長い画像表示区間\n");
    const sparseJob = makeJob(sparseId, logicalRoot);
    sparseJob.images[0].start_seconds = 0; sparseJob.images[0].end_seconds = 12; sparseJob.images[0].duration_seconds = 12;
    sparseJob.images[1].start_seconds = 12; sparseJob.images[1].end_seconds = 24; sparseJob.images[1].duration_seconds = 12;
    sparseJob.output.filename = "sparse.mp4";
    fs.writeFileSync(path.join(sparseDirectory, "job.json"), `${JSON.stringify(sparseJob, null, 2)}\n`);
    const sparse = generateManualVideo(sparseId, { root, logicalRoot, pathMappings: [{ logicalRoot, hostRoot: root }], now: () => new Date(`2026-07-14T15:00:0${tick++}.000Z`) });
    assert.equal(sparse.job.status, "video_ready");
    assert.equal(sparse.media.fps, 30); assert.equal(sparse.media.pix_fmt, "yuv420p");
    assert(Math.abs(sparse.media.duration_seconds - 24) < 0.1);
    assert(Math.abs(sparse.media.video_duration_seconds - 24) < 0.1);
    assert(Math.abs(sparse.media.audio_duration_seconds - 24) < 0.1);

    const mismatchMessages = mediaMismatches({
      video_codec: "hevc", audio_codec: "mp3", width: 640, height: 360, fps: 25, pix_fmt: "yuv444p",
      duration_seconds: 9, video_duration_seconds: 8.5, audio_duration_seconds: 8,
    }, { width: 768, height: 512, duration_seconds: 10 });
    assert(mismatchMessages.some((message) => message.includes("video codec expected=h264 actual=hevc")));
    assert(mismatchMessages.some((message) => message.includes("fps expected=30 actual=25")));
    assert(mismatchMessages.some((message) => message.includes("video duration expected=10.000000 actual=8.500000 diff=1.500000 tolerance=0.100")));

    const badId = "job_20260714T150100Z_video_bad"; const badDirectory = path.join(root, badId);
    fs.cpSync(directory, badDirectory, { recursive: true }); fs.rmSync(path.join(badDirectory, "video"), { recursive: true }); fs.mkdirSync(path.join(badDirectory, "video"));
    const badJob = makeJob(badId, logicalRoot); fs.writeFileSync(path.join(badDirectory, "uploads", "image_001.png"), "not an image"); fs.writeFileSync(path.join(badDirectory, "uploads", "image_002.png"), "also not an image"); fs.writeFileSync(path.join(badDirectory, "job.json"), `${JSON.stringify(badJob, null, 2)}\n`);
    assert.throws(() => generateManualVideo(badId, { root, logicalRoot, pathMappings: [{ logicalRoot, hostRoot: root }], now: () => new Date(`2026-07-14T15:01:0${tick++}.000Z`) }), (error) => error.code === "MEDIA_COMMAND_FAILED");
    const failed = JSON.parse(fs.readFileSync(path.join(badDirectory, "job.json"), "utf8")); assert.equal(failed.status, "failed"); assert.equal(failed.error.stage, "video_generating"); assert.equal(fs.existsSync(path.join(badDirectory, "video", "manual-test.mp4")), false);
    console.log("manual video generation tests: ok");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})();
