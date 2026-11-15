"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { advanceJob, candidateJobs } = require("../backend/manual-job-worker");

function writeJob(root, id, status = "queued") {
  const directory = path.join(root, id);
  fs.mkdirSync(directory);
  for (const name of ["audio", "subtitles", "video", "uploads"]) fs.mkdirSync(path.join(directory, name));
  const job = {
    version: 2, mode: "manual", job_id: id, status, current_stage: status,
    created_at: "2026-07-14T00:00:00.000Z", updated_at: "2026-07-14T00:00:00.000Z",
    input: { title: "test", subtitle_text: "字幕", speech_text: "よみ", request_note: "" },
    segments: [], images: [{ id: "image_001", source: "upload", order: 1, stored_path: "/logical/image.png" }],
    output: { filename: null, aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" },
    artifacts: { audio_file: null, subtitle_file: null, video_file: null },
    voice_profile: "calm_female_06", attempts: 0, history: [], review: { required: false, reasons: [] }, error: null,
  };
  fs.writeFileSync(path.join(directory, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
  return directory;
}

function mutate(root, id, fn) {
  const file = path.join(root, id, "job.json");
  const job = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(job);
  job.updated_at = new Date(Date.parse(job.updated_at) + 1000).toISOString();
  fs.writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`);
  return job;
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "manual-worker-test-"));
  const jobsRoot = path.join(temporary, "jobs");
  const libraryRoot = path.join(temporary, "library");
  fs.mkdirSync(jobsRoot); fs.mkdirSync(libraryRoot);
  const id = "job_20260714T000000Z_worker";
  writeJob(jobsRoot, id);
  const calls = [];
  const operations = {
    segment(jobId) { calls.push("segment"); mutate(jobsRoot, jobId, (job) => { job.status = "segments_ready"; job.current_stage = "segments_ready"; job.segments = [{ id: "segment_001", subtitle_text: "字幕", speech_text: "よみ", audio: { status: "pending", path: null, duration_seconds: null, error: null } }]; }); },
    async generateSegmentAudio(jobId) { calls.push("tts"); mutate(jobsRoot, jobId, (job) => { job.status = "audio_ready"; job.current_stage = "audio_ready"; job.segments[0].audio = { status: "generated", path: "/logical/segment.wav", duration_seconds: null, error: null }; }); },
    checkAudioQuality(jobId) { calls.push("quality"); mutate(jobsRoot, jobId, (job) => { job.audio_quality = { status: "passed", anomalies: [] }; }); },
    assembleAudio(jobId) { calls.push("assemble"); mutate(jobsRoot, jobId, (job) => { job.artifacts.audio_file = "/logical/assembled.wav"; job.segments[0].audio.duration_seconds = 1; job.segments[0].timing = { start_seconds: 0, end_seconds: 1 }; }); },
    generateSubtitles(jobId) { calls.push("subtitle"); mutate(jobsRoot, jobId, (job) => { job.status = "subtitle_ready"; job.current_stage = "subtitle_ready"; job.artifacts.subtitle_file = "/logical/final.srt"; }); },
    planImages(jobId) { calls.push("images"); mutate(jobsRoot, jobId, (job) => { job.status = "images_ready"; job.current_stage = "images_ready"; job.images[0].start_seconds = 0; job.images[0].end_seconds = 1; job.images[0].duration_seconds = 1; }); },
    generateVideo(jobId) { calls.push("video"); mutate(jobsRoot, jobId, (job) => { job.status = "video_ready"; job.current_stage = "video_ready"; job.output.filename = "out.mp4"; job.artifacts.video_file = "/logical/out.mp4"; }); },
    archive(jobId) { calls.push("archive"); mutate(jobsRoot, jobId, (job) => { job.archive = { status: "local_only" }; }); },
  };
  const config = {
    jobsRoot, logicalRoot: "/logical/jobs", imageLibraryRoot: libraryRoot, imageLibraryLogicalRoot: "/logical/library",
    voiceProfilesPath: path.join(temporary, "profiles.json"), irodoriUrl: "http://127.0.0.1:7861", irodoriTimeoutMs: 1000,
    gapSeconds: 0, localArchiveRoot: path.join(temporary, "archive"), localArchiveLogicalRoot: "/logical/archive",
    nasArchiveRoot: null, nasArchiveLogicalRoot: "/logical/nas", retryFailed: false, maxRetries: 3, pollMs: 1000,
  };
  fs.writeFileSync(config.voiceProfilesPath, "{}\n"); fs.mkdirSync(config.localArchiveRoot);

  for (let index = 0; index < 8; index += 1) await advanceJob(id, config, operations);
  assert.deepEqual(calls, ["segment", "tts", "quality", "assemble", "subtitle", "images", "video", "archive"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobsRoot, id, "job.json"), "utf8")).status, "video_ready");
  assert.equal(candidateJobs(config).length, 0);

  const mismatchId = "job_20260714T000100Z_mismatch";
  writeJob(jobsRoot, mismatchId);
  mutate(jobsRoot, mismatchId, (job) => {
    job.input.subtitle_text = "字幕1。\n\n字幕2。";
    job.input.speech_text = "よみ1。\n\nよみ2。\n\nよみ3。";
  });
  await assert.rejects(
    () => advanceJob(mismatchId, { ...config, retryFailed: true }),
    (error) => error.code === "SEGMENT_COUNT_MISMATCH" && error.retryable === false,
  );
  const mismatchJob = JSON.parse(fs.readFileSync(path.join(jobsRoot, mismatchId, "job.json"), "utf8"));
  assert.equal(mismatchJob.status, "failed");
  assert.equal(mismatchJob.current_stage, "failed");
  assert.equal(mismatchJob.error.stage, "segmenting");
  assert.equal(mismatchJob.error.retryable, false);
  assert.match(mismatchJob.error.message, /字幕側2件、読み側3件/);
  const workerState = JSON.parse(fs.readFileSync(path.join(jobsRoot, mismatchId, ".worker-state.json"), "utf8"));
  assert.equal(workerState.failures, 1);
  assert.equal(workerState.last_error.retryable, false);
  assert.equal(candidateJobs({ ...config, retryFailed: true }).length, 0);

  const nextId = "job_20260714T000200Z_next";
  writeJob(jobsRoot, nextId);
  assert.deepEqual(candidateJobs({ ...config, retryFailed: true }).map((job) => job.id), [nextId]);

  const retryId = "job_20260714T000300Z_retry";
  writeJob(jobsRoot, retryId, "audio_ready");
  mutate(jobsRoot, retryId, (job) => {
    job.segments = [{ id: "seg_001", order: 1, subtitle_text: "字幕", speech_text: "よみ", audio: { status: "generated", path: "/logical/seg.wav", duration_seconds: null, error: null }, timing: { start_seconds: null, end_seconds: null } }];
    job.audio_quality = { status: "passed", anomalies: [] };
  });
  let assemblyCalls = 0;
  const retryOperations = {
    ...operations,
    assembleAudio(jobId) {
      assemblyCalls += 1;
      if (assemblyCalls === 1) {
        const error = new Error("一時的な音声処理失敗"); error.code = "MEDIA_COMMAND_FAILED"; error.retryable = true; throw error;
      }
      mutate(jobsRoot, jobId, (job) => { job.artifacts.audio_file = "/logical/assembled.wav"; });
    },
  };
  await assert.rejects(() => advanceJob(retryId, { ...config, retryFailed: true }, retryOperations), /一時的な音声処理失敗/);
  let retryJob = JSON.parse(fs.readFileSync(path.join(jobsRoot, retryId, "job.json"), "utf8"));
  assert.equal(retryJob.status, "failed"); assert.equal(retryJob.error.stage, "audio_ready"); assert.equal(retryJob.error.retryable, true);
  assert(candidateJobs({ ...config, retryFailed: true }).some((job) => job.id === retryId));
  await advanceJob(retryId, { ...config, retryFailed: true }, retryOperations);
  retryJob = JSON.parse(fs.readFileSync(path.join(jobsRoot, retryId, "job.json"), "utf8"));
  assert.equal(retryJob.status, "audio_ready"); assert.equal(retryJob.error, null); assert.equal(retryJob.artifacts.audio_file, "/logical/assembled.wav");
  const clearedState = JSON.parse(fs.readFileSync(path.join(jobsRoot, retryId, ".worker-state.json"), "utf8")); assert.equal(clearedState.failures, 0); assert.equal(clearedState.last_error, null);

  const exhaustedId = "job_20260714T000400Z_exhausted";
  writeJob(jobsRoot, exhaustedId, "audio_ready");
  mutate(jobsRoot, exhaustedId, (job) => {
    job.segments = [{ id: "seg_001", order: 1, subtitle_text: "字幕", speech_text: "よみ", audio: { status: "generated", path: "/logical/seg.wav", duration_seconds: null, error: null }, timing: { start_seconds: null, end_seconds: null } }];
    job.audio_quality = { status: "passed", anomalies: [] };
  });
  const alwaysFail = { ...operations, assembleAudio() { const error = new Error("継続する一時障害"); error.code = "MEDIA_COMMAND_FAILED"; error.retryable = true; throw error; } };
  const limitedConfig = { ...config, retryFailed: true, maxRetries: 2 };
  await assert.rejects(() => advanceJob(exhaustedId, limitedConfig, alwaysFail), /継続する一時障害/);
  await assert.rejects(() => advanceJob(exhaustedId, limitedConfig, alwaysFail), /継続する一時障害/);
  const exhaustedJob = JSON.parse(fs.readFileSync(path.join(jobsRoot, exhaustedId, "job.json"), "utf8"));
  assert.equal(exhaustedJob.status, "failed"); assert.equal(exhaustedJob.error.retryable, false); assert.match(exhaustedJob.error.message, /上限/);
  assert.equal(candidateJobs(limitedConfig).some((job) => job.id === exhaustedId), false);

  const busyId = "job_20260714T000500Z_busy";
  const busyDirectory = writeJob(jobsRoot, busyId);
  fs.writeFileSync(path.join(busyDirectory, ".manual-worker.lock"), `${process.pid}\n`);
  const busyBefore = fs.readFileSync(path.join(busyDirectory, "job.json"), "utf8");
  assert.equal((await advanceJob(busyId, config, operations)).outcome, "busy");
  assert.equal(fs.readFileSync(path.join(busyDirectory, "job.json"), "utf8"), busyBefore);
  fs.rmSync(temporary, { recursive: true, force: true });
  process.stdout.write("manual job worker tests: ok\n");
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
