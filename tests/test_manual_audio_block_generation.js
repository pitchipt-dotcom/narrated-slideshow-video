"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  generateManualAudioBlock, silentWavBuffer,
} = require("../backend/manual-segment-audio-generation");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-audio-block-generation-"));
const id = "job_20260728T000000Z_block_test";
const directory = path.join(root, id);
fs.mkdirSync(path.join(directory, "audio"), { recursive: true });
const profilePath = path.join(root, "profiles.json");
fs.writeFileSync(profilePath, JSON.stringify({ profiles: { calm_female_06: {
  model: "irodori-tts", caption: "落ち着いた声", voice: "sample", steps: 4, tempo: 1,
} } }));
const baseBlock = {
  id: "block_000", audio_block_index: 0, subtitle_segment_indexes: [0, 1],
  segment_ids: ["seg_001", "seg_002"], text: "最初の文です。次の文です。",
  readable_characters: 12, sentence_count: 2, audio_path: null, status: "pending",
  duration_seconds: null, seed: null, started_at: null, completed_at: null, error: null, retry_count: 0,
};
fs.writeFileSync(path.join(directory, "job.json"), JSON.stringify({
  version: 2, mode: "manual", job_id: id, status: "segments_ready", current_stage: "segments_ready",
  updated_at: "2026-07-28T00:00:00.000Z", voice_profile: "calm_female_06", voice_generation: null,
  attempts: 0, error: null, history: [], audio_blocks: [baseBlock],
}));
const times = [
  new Date("2026-07-28T00:01:00.000Z"),
  new Date("2026-07-28T00:01:02.000Z"),
];
let calls = 0;
(async () => {
  const result = await generateManualAudioBlock(id, "block_000", {
    root, logicalRoot: "/logical/manual", voiceProfilesPath: profilePath,
    now: () => times.shift(),
    synthesize: async () => { calls += 1; return silentWavBuffer(2); },
  });
  assert.equal(calls, 1);
  assert.equal(result.job.audio_blocks[0].status, "completed");
  assert.equal(result.job.audio_blocks[0].seed, result.job.voice_generation.seed);
  assert.equal(result.job.audio_blocks[0].started_at, "2026-07-28T00:01:00.000Z");
  assert.equal(result.job.audio_blocks[0].completed_at, "2026-07-28T00:01:02.000Z");
  assert(result.job.audio_blocks[0].duration_seconds >= 1.99);
  assert.equal(result.job.status, "audio_ready");
  const reused = await generateManualAudioBlock(id, "block_000", {
    root, logicalRoot: "/logical/manual", voiceProfilesPath: profilePath,
  });
  assert.equal(reused.reused, true);
  console.log("manual audio block generation tests: ok");
})().finally(() => fs.rmSync(root, { recursive: true, force: true }));
