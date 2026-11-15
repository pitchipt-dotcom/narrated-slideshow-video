"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildVoiceGeneration, generateManualSegmentAudio, validateWav } = require("../backend/manual-segment-audio-generation");

function wavBuffer() {
  const buffer = Buffer.alloc(48);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(40, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(4, 40);
  return buffer;
}

function makeFakeIrodori() {
  const requests = [];
  let failNextGeneration = false;
  const baseUrl = "http://irodori.test";
  async function fetchImpl(input, options = {}) {
    const url = String(input);
    const method = options.method || "GET";
    if (method === "GET" && url === `${baseUrl}/health`) {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "POST" && url === `${baseUrl}/v1/audio/speech`) {
      requests.push(JSON.parse(options.body));
      if (failNextGeneration) {
        failNextGeneration = false;
        return new Response("unavailable", { status: 503 });
      }
      return new Response(wavBuffer(), { status: 200, headers: { "content-type": "audio/wav" } });
    }
    return new Response("not found", { status: 404 });
  }
  return {
    requests,
    failOnce() { failNextGeneration = true; },
    url: baseUrl,
    fetchImpl,
  };
}

function makeJob(jobId) {
  const created = "2026-07-14T09:00:00.000Z";
  return {
    version: 2, mode: "manual", job_id: jobId, status: "segments_ready", current_stage: "segments_ready",
    created_at: created, updated_at: created,
    input: { title: "テスト", subtitle_text: "画面用一。画面用二。", speech_text: "よみいち。よみに。", request_note: "" },
    segments: [
      { id: "seg_001", order: 1, subtitle_text: "画面にだけ出す秘密の表記一。", speech_text: "よみいち。", image_id: null, requested_image_duration_seconds: null, audio: { status: "pending", path: null, duration_seconds: null, error: null }, timing: { start_seconds: null, end_seconds: null } },
      { id: "seg_002", order: 2, subtitle_text: "画面にだけ出す秘密の表記二。", speech_text: "よみに。", image_id: null, requested_image_duration_seconds: null, audio: { status: "pending", path: null, duration_seconds: null, error: null }, timing: { start_seconds: null, end_seconds: null } },
    ],
    images: [], output: { filename: null, aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" },
    artifacts: { audio_file: null, subtitle_file: null, video_file: null }, voice_profile: "calm_female_06", attempts: 0,
    history: [{ at: created, stage: "segments_ready", message: "テスト準備" }], review: { required: false, reasons: [] }, error: null,
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-audio-test-"));
  const jobId = "job_20260714T090000Z_audio_test";
  const jobDirectory = path.join(root, jobId);
  const profilePath = path.join(root, "voice_profiles.json");
  const dictionaryPath = path.join(root, "dictionary.json");
  fs.mkdirSync(path.join(jobDirectory, "audio"), { recursive: true });
  fs.writeFileSync(path.join(jobDirectory, "job.json"), `${JSON.stringify(makeJob(jobId), null, 2)}\n`);
  fs.writeFileSync(profilePath, `${JSON.stringify({ profiles: { calm_female_06: { model: "test-model", caption: "test-caption", steps: 4, tempo: 1.1 } } })}\n`);
  fs.writeFileSync(dictionaryPath, JSON.stringify({ version: 1, entries: [{ source: "よみいち", reading: "辞書適用" }] }));
  const service = makeFakeIrodori();
  let tick = 0;
  const options = {
    root, voiceProfilesPath: profilePath, pronunciationDictionaryPath: dictionaryPath, irodoriUrl: service.url, fetchImpl: service.fetchImpl,
    logicalRoot: "/data/test/manual_jobs",
    now: () => new Date(`2026-07-14T09:00:0${tick++}.000Z`),
  };
  try {
    assert.throws(() => validateWav(Buffer.alloc(44)), (error) => error.code === "INVALID_WAV");
    const snapshot = buildVoiceGeneration("calm_female_06", { model: "test-model", caption: "test-caption", steps: 4, tempo: 1.1 });
    assert.throws(() => buildVoiceGeneration("calm_female_06", { model: "test-model", caption: "test-caption", steps: 4, tempo: 1.1 }, { ...snapshot, profile_fingerprint: "0".repeat(64) }), (error) => error.code === "VOICE_CONDITION_MISMATCH");
    const first = await generateManualSegmentAudio(jobId, "seg_001", options);
    assert.equal(first.reused, false);
    assert.equal(first.job.segments[0].audio.status, "generated");
    assert.equal(first.job.segments[1].audio.status, "pending");
    assert.equal(first.job.segments[0].audio.path, `/data/test/manual_jobs/${jobId}/audio/seg_001.wav`);
    assert.equal(fs.readFileSync(path.join(jobDirectory, "audio", "seg_001.wav")).subarray(0, 4).toString(), "RIFF");
    assert.equal(service.requests.length, 1);
    assert.equal(service.requests[0].input, "辞書適用。");
    assert.equal(JSON.stringify(service.requests[0]).includes("画面にだけ出す"), false);
    assert.equal(service.requests[0].model, "irodori-tts");
    assert.equal(service.requests[0].voice, "sample");
    assert.equal(service.requests[0].irodori.caption, "test-caption");
    assert.equal(service.requests[0].irodori.num_steps, 4);
    assert.equal(Number.isInteger(service.requests[0].irodori.seed), true);
    const fixedSeed = service.requests[0].irodori.seed;
    assert.equal(first.job.voice_generation.seed, Number(fixedSeed));
    assert.equal(first.job.voice_generation.conditioning_mode, "caption_and_reference");
    assert.equal(first.job.voice_generation.reference_audio_used, true);
    assert.match(first.job.voice_generation.profile_fingerprint, /^[a-f0-9]{64}$/);

    const reused = await generateManualSegmentAudio(jobId, "seg_001", options);
    assert.equal(reused.reused, true);
    assert.equal(service.requests.length, 1);

    service.failOnce();
    await assert.rejects(generateManualSegmentAudio(jobId, "seg_002", options), (error) => error.code === "IRODORI_HTTP_ERROR");
    let saved = JSON.parse(fs.readFileSync(path.join(jobDirectory, "job.json"), "utf8"));
    assert.equal(saved.segments[1].audio.status, "failed");
    assert.equal(saved.segments[0].audio.status, "generated");
    assert.equal(saved.error.segment_id, "seg_002");
    assert.equal(JSON.stringify(saved.history).includes("よみに"), false);
    assert.equal(JSON.stringify(saved.history).includes("画面にだけ出す"), false);

    const retried = await generateManualSegmentAudio(jobId, "seg_002", options);
    assert.equal(retried.job.status, "audio_ready");
    assert.equal(retried.job.segments.every((segment) => segment.audio.status === "generated"), true);
    assert.equal(retried.job.attempts, 3);
    assert.equal(service.requests.at(-1).input, "よみに。");
    assert.equal(service.requests.at(-1).irodori.seed, fixedSeed);
    for (const request of service.requests) {
      assert.deepEqual({ ...request, input: "" }, { ...service.requests[0], input: "" });
    }
    assert.equal(fs.existsSync(path.join(jobDirectory, "audio", "seg_002.wav")), true);

    const readyReuse = await generateManualSegmentAudio(jobId, "seg_002", options);
    assert.equal(readyReuse.reused, true);
    assert.equal(readyReuse.job.status, "audio_ready");
    assert.equal(service.requests.length, 3);

    const separatorId = "job_20260714T090100Z_audio_separator";
    const separatorDirectory = path.join(root, separatorId);
    fs.mkdirSync(path.join(separatorDirectory, "audio"), { recursive: true });
    const separatorJob = makeJob(separatorId);
    separatorJob.segments = [separatorJob.segments[0]];
    separatorJob.segments[0].speech_text = "---";
    separatorJob.input.speech_text = "---";
    fs.writeFileSync(path.join(separatorDirectory, "job.json"), `${JSON.stringify(separatorJob, null, 2)}\n`);
    const requestCount = service.requests.length;
    const separator = await generateManualSegmentAudio(separatorId, "seg_001", { ...options, now: new Date("2026-07-14T09:01:00.000Z") });
    assert.equal(separator.job.status, "audio_ready");
    assert.equal(service.requests.length, requestCount);
    assert(fs.statSync(path.join(separatorDirectory, "audio", "seg_001.wav")).size > 44);
    assert.match(JSON.stringify(separator.job.history), /装飾区切りを意図的無音/);
    console.log("manual segment audio generation tests: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
