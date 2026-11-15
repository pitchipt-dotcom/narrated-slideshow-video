"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkManualAudioQuality, classifyMetrics } = require("../backend/manual-audio-quality");

function metric(duration, rms, peak, f0, sha) {
  return { duration_seconds: duration, rms_dbfs: rms, peak_dbfs: peak, zero_crossing_rate: 0.08, f0_median_hz: f0, f0_voiced_frames: 8, sha256: sha.repeat(64) };
}

(() => {
  const classified = classifyMetrics([
    { segment_id: "seg_001", speech_characters: 10, metrics: metric(2, -20, -3, 180, "a") },
    { segment_id: "seg_002", speech_characters: 10, metrics: metric(2.1, -21, -4, 185, "b") },
    { segment_id: "seg_003", speech_characters: 10, metrics: metric(0.2, -60, -35, 320, "c") },
  ]);
  assert.deepEqual(classified.anomalies.map((item) => item.segment_id), ["seg_003"]);
  assert(classified.anomalies[0].reasons.includes("DURATION_TOO_SHORT"));
  assert(classified.anomalies[0].reasons.includes("VERY_LOW_LEVEL"));
  assert.equal(classified.anomalies[0].reasons.some((reason) => reason.includes("F0")), false);

  const intentional = classifyMetrics([
    { segment_id: "seg_001", speech_characters: 10, intentional_silence: false, metrics: metric(2, -20, -3, 180, "a") },
    { segment_id: "seg_002", speech_characters: 0, intentional_silence: true, metrics: metric(0.5, -120, -120, null, "b") },
    { segment_id: "seg_003", speech_characters: 10, intentional_silence: false, metrics: metric(2.1, -21, -4, 185, "c") },
  ]);
  assert.deepEqual(intentional.anomalies, []);
  assert(intentional.baselines.rms_dbfs > -22 && intentional.baselines.rms_dbfs < -19);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-quality-test-"));
  const id = "job_20260716T000000Z_quality";
  const directory = path.join(root, id);
  fs.mkdirSync(path.join(directory, "audio"), { recursive: true });
  const segments = [1, 2, 3, 4].map((order) => ({
    id: `seg_${String(order).padStart(3, "0")}`,
    order,
    subtitle_text: `字幕${order}`,
    speech_text: `読み上げ文章${order}です。`,
    audio: { status: "generated", path: `/logical/seg_${order}.wav`, duration_seconds: null, error: null },
  }));
  segments[3].speech_text = "---";
  for (const segment of segments) fs.writeFileSync(path.join(directory, "audio", `${segment.id}.wav`), "test");
  const job = { version: 2, mode: "manual", job_id: id, status: "audio_ready", current_stage: "audio_ready", updated_at: "2026-07-16T00:00:00.000Z", segments, history: [], review: { required: false, reasons: [] }, error: null };
  fs.writeFileSync(path.join(directory, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
  let index = 0;
  const result = checkManualAudioQuality(id, {
    root,
    analyzeFile() {
      index += 1;
      if (index === 3) return metric(0.2, -60, -35, 320, "c");
      if (index === 4) return metric(0.5, -120, -120, null, "d");
      return metric(2, -20, -3, 180, index === 1 ? "a" : "b");
    },
  });
  assert.equal(result.job.status, "audio_ready");
  assert.equal(result.job.audio_quality.status, "attention");
  assert.deepEqual(result.job.audio_quality.anomalies.map((item) => item.segment_id), ["seg_003"]);
  assert.equal(result.job.audio_quality.segments[3].intentional_silence, true);
  assert.equal(result.job.audio_quality.f0_is_diagnostic_alone, false);
  assert.equal(result.job.review.required, true);
  assert(result.job.review.reasons.includes("AUDIO_QUALITY_ATTENTION"));
  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write("manual audio quality tests: ok\n");
})();
