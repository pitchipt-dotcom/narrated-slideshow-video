"use strict";

const assert = require("node:assert/strict");
const { stallStatus } = require("../backend/pipeline-stall-status");

const now = new Date("2026-07-26T04:00:00.000Z");
const stalled = stallStatus({
  status: "suitability_review",
  current_stage: "suitability_review",
  updated_at: "2026-07-26T03:30:00.000Z",
}, now);
assert.equal(stalled.is_stalled, true);
assert.equal(stalled.stale_minutes, 30);
assert.equal(stalled.timeout_minutes, 20);
assert.match(stalled.stall_message, /停止の可能性あり/);

const active = stallStatus({
  status: "audio_generating",
  current_stage: "audio_generating",
  last_progress_at: "2026-07-26T03:50:00.000Z",
  updated_at: "2026-07-26T03:00:00.000Z",
}, now);
assert.equal(active.is_stalled, false);
assert.equal(active.stale_minutes, 10);

const humanWait = stallStatus({
  status: "waiting_for_image_review",
  current_stage: "waiting_for_image_review",
  updated_at: "2026-07-25T00:00:00.000Z",
}, now);
assert.equal(humanWait.is_stalled, false);

const completed = stallStatus({
  status: "completed",
  current_stage: "completed",
  updated_at: "2026-07-25T00:00:00.000Z",
}, now);
assert.equal(completed.is_stalled, false);

console.log("pipeline stall status tests: ok");
