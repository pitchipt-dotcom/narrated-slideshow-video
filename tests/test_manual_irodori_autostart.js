"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MARKER_NAME, autostartEnabled, ensureIrodori, hostIsIdle, startBlocker, stopIrodoriIfOwned,
} = require("../backend/manual-irodori-autostart");
const { advanceJob, runOne } = require("../backend/manual-job-worker");
const { getManualJobStatus } = require("../backend/manual-job-status");

const IDLE_HOST = {
  resources: { mode: "IDLE", lifecycle: "IDLE", active_job: null, waiting_jobs: 0, running_model: null, running_tool: null, loaded_model: null },
  gpu: { loaded_model: null, active_job: null, transition: null, queued: 0, model_states: { model_a: "STOPPED", model_b: "STOPPED", model_c: "STOPPED" } },
};

// A fake machine: one unit, one GPU, one Host.
function fakeMachine(overrides = {}) {
  const machine = {
    active: false, healthy: false, invocation: "", counter: 0, clock: 0,
    host: structuredClone(IDLE_HOST), hostDown: false, gpuProcesses: 0, gpuDown: false,
    startCode: 0, healthyAfterMs: 3000, startedAt: null, calls: [],
    ...overrides,
  };
  machine.dependencies = {
    async irodoriHealthy() {
      if (machine.active && machine.startedAt !== null && machine.clock - machine.startedAt >= machine.healthyAfterMs) machine.healthy = true;
      return machine.active && machine.healthy;
    },
    async unitActive() { return machine.active; },
    async invocationId() { return machine.invocation; },
    async hostState() { machine.calls.push("host"); if (machine.hostDown) throw new Error("down"); return machine.host; },
    async gpuComputeProcesses() { machine.calls.push("gpu"); if (machine.gpuDown) throw new Error("no nvidia-smi"); return machine.gpuProcesses; },
    async startUnit() {
      machine.calls.push("start");
      if (machine.startCode !== 0) return { code: machine.startCode };
      machine.active = true; machine.startedAt = machine.clock; machine.counter += 1; machine.invocation = `inv-${machine.counter}`;
      return { code: 0 };
    },
    async stopUnit() { machine.calls.push("stop"); machine.active = false; machine.healthy = false; machine.invocation = ""; return { code: 0 }; },
    async sleep(ms) { machine.clock += ms; },
    now() { return machine.clock; },
  };
  return machine;
}

function manualStart(machine) {
  machine.active = true; machine.healthy = true; machine.counter += 1; machine.invocation = `manual-${machine.counter}`;
}

function writeAudioJob(root, id) {
  const directory = path.join(root, id);
  fs.mkdirSync(directory);
  for (const name of ["audio", "subtitles", "video", "uploads"]) fs.mkdirSync(path.join(directory, name));
  const job = {
    version: 2, mode: "manual", job_id: id, status: "segments_ready", current_stage: "segments_ready",
    created_at: "2026-07-14T00:00:00.000Z", updated_at: "2026-07-14T00:00:00.000Z",
    input: { title: "test", subtitle_text: "字幕", speech_text: "よみ", request_note: "" },
    segments: [{ id: "seg_001", order: 1, subtitle_text: "字幕", speech_text: "よみ", audio: { status: "pending", path: null, duration_seconds: null, error: null } }],
    images: [{ id: "image_001", source: "upload", order: 1, stored_path: "/logical/image.png" }],
    output: { filename: null, aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" },
    artifacts: { audio_file: null, subtitle_file: null, video_file: null },
    voice_profile: "calm_female_06", attempts: 0, history: [], review: { required: false, reasons: [] }, error: null,
  };
  fs.writeFileSync(path.join(directory, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
}

function readJob(root, id) { return JSON.parse(fs.readFileSync(path.join(root, id, "job.json"), "utf8")); }

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "manual-irodori-autostart-test-"));
  const stateRoot = path.join(temporary, "jobs");
  fs.mkdirSync(stateRoot);
  const marker = path.join(stateRoot, MARKER_NAME);

  // Setting: opt-in.
  assert.equal(autostartEnabled({}), false);
  assert.equal(autostartEnabled({ MANUAL_IRODORI_AUTOSTART: "" }), false);
  assert.equal(autostartEnabled({ MANUAL_IRODORI_AUTOSTART: "1" }), true);
  assert.equal(autostartEnabled({ MANUAL_IRODORI_AUTOSTART: "0" }), false);
  assert.equal(autostartEnabled({ MANUAL_IRODORI_AUTOSTART: "false" }), false);

  // Host idle judgement.
  assert.equal(hostIsIdle(IDLE_HOST), true);
  for (const change of [
    (state) => { state.resources.mode = "BUSY"; },
    (state) => { state.resources.active_job = "job-1"; },
    (state) => { state.resources.waiting_jobs = 1; },
    (state) => { state.resources.loaded_model = "model_a"; },
    (state) => { state.gpu.model_states.model_b = "RUNNING"; },
    (state) => { state.gpu.model_states.model_a = "STARTING"; },
    (state) => { state.gpu.loaded_model = "model_b"; },
    (state) => { state.gpu.transition = { to: "model_a" }; },
    (state) => { delete state.gpu.model_states; },
  ]) {
    const state = structuredClone(IDLE_HOST); change(state);
    assert.equal(hostIsIdle(state), false);
  }
  assert.equal(hostIsIdle(null), false);
  assert.equal(await startBlocker(fakeMachine().dependencies), null);
  assert.equal(await startBlocker(fakeMachine({ hostDown: true }).dependencies), "host_unknown");
  // No coordinator configured: only the GPU process check applies.
  assert.equal(await startBlocker(fakeMachine({ host: null }).dependencies), null);
  assert.equal(await startBlocker(fakeMachine({ host: null, gpuProcesses: 1 }).dependencies), "gpu_busy");
  assert.equal(await startBlocker(fakeMachine({ gpuProcesses: 1 }).dependencies), "gpu_busy");
  assert.equal(await startBlocker(fakeMachine({ gpuDown: true }).dependencies), "gpu_unknown");

  // Stopped + everything free: start, record ownership, wait for /health.
  let machine = fakeMachine();
  let result = await ensureIrodori({ stateRoot, dependencies: machine.dependencies });
  assert.deepEqual(result, { ready: true, started: true });
  assert.deepEqual(machine.calls, ["host", "gpu", "start"]);
  assert.equal(machine.clock >= 3000, true, "must wait until /health is ok");
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).invocation_id, "inv-1");

  // Already healthy: nothing is checked or started again.
  machine.calls.length = 0;
  assert.deepEqual(await ensureIrodori({ stateRoot, dependencies: machine.dependencies }), { ready: true, started: false });
  assert.deepEqual(machine.calls, []);

  // No unfinished jobs: the instance the worker started is stopped.
  result = await stopIrodoriIfOwned({ stateRoot, dependencies: machine.dependencies });
  assert.deepEqual(result, { stopped: true, reason: "no_unfinished_jobs" });
  assert.equal(machine.active, false);
  assert.equal(fs.existsSync(marker), false);

  // Host busy / GPU busy / unknown: never start, report the reason.
  for (const [overrides, reason] of [
    [{ host: { ...structuredClone(IDLE_HOST), resources: { ...IDLE_HOST.resources, mode: "RUNNING", active_job: "j" } } }, "host_busy"],
    [{ hostDown: true }, "host_unknown"],
    [{ gpuProcesses: 2 }, "gpu_busy"],
    [{ gpuDown: true }, "gpu_unknown"],
  ]) {
    machine = fakeMachine(overrides);
    result = await ensureIrodori({ stateRoot, dependencies: machine.dependencies });
    assert.equal(result.ready, false); assert.equal(result.reason, reason); assert.equal(typeof result.message, "string");
    assert.equal(machine.calls.includes("start"), false);
    assert.equal(machine.active, false);
    assert.equal(fs.existsSync(marker), false);
  }

  // Start command refused, and a start that never becomes healthy.
  machine = fakeMachine({ startCode: 1 });
  assert.equal((await ensureIrodori({ stateRoot, dependencies: machine.dependencies })).reason, "start_failed");
  assert.equal(fs.existsSync(marker), false);
  machine = fakeMachine({ healthyAfterMs: 10 ** 9 });
  result = await ensureIrodori({ stateRoot, dependencies: machine.dependencies, startTimeoutMs: 5000 });
  assert.equal(result.reason, "start_timeout");
  // It is still ours, so it is cleaned up once no job is left.
  assert.equal((await stopIrodoriIfOwned({ stateRoot, dependencies: machine.dependencies })).stopped, true);

  // Started by hand: used as is, and never stopped by the worker.
  machine = fakeMachine(); manualStart(machine);
  assert.deepEqual(await ensureIrodori({ stateRoot, dependencies: machine.dependencies }), { ready: true, started: false });
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(await stopIrodoriIfOwned({ stateRoot, dependencies: machine.dependencies }), { stopped: false, reason: "not_owned" });
  assert.equal(machine.active, true);
  assert.equal(machine.calls.includes("stop"), false);

  // Started by hand but still loading: wait for it without starting or owning it.
  machine = fakeMachine({ active: true, startedAt: 0, invocation: "manual-x" });
  assert.deepEqual(await ensureIrodori({ stateRoot, dependencies: machine.dependencies }), { ready: true, started: false });
  assert.deepEqual(machine.calls, []);
  assert.equal(fs.existsSync(marker), false);

  // Worker started it, then a person stopped and started it again: not ours any more.
  machine = fakeMachine();
  await ensureIrodori({ stateRoot, dependencies: machine.dependencies });
  machine.active = false; manualStart(machine);
  assert.deepEqual(await stopIrodoriIfOwned({ stateRoot, dependencies: machine.dependencies }), { stopped: false, reason: "restarted_by_someone_else" });
  assert.equal(machine.active, true);
  assert.equal(fs.existsSync(marker), false);

  // Worker started it, then a person stopped it: only the marker is cleared.
  machine = fakeMachine();
  await ensureIrodori({ stateRoot, dependencies: machine.dependencies });
  machine.active = false; machine.calls.length = 0;
  assert.deepEqual(await stopIrodoriIfOwned({ stateRoot, dependencies: machine.dependencies }), { stopped: false, reason: "already_stopped" });
  assert.deepEqual(machine.calls, []);

  // Worker integration: a blocked start keeps the job waiting without a failure.
  const config = {
    jobsRoot: stateRoot, logicalRoot: "/logical/jobs", retryFailed: true, maxRetries: 3, irodoriAutostart: true,
    voiceProfilesPath: "/nonexistent", irodoriUrl: "http://127.0.0.1:1", irodoriTimeoutMs: 1000,
  };
  const id = "job_20260714T000000Z_ttswait";
  writeAudioJob(stateRoot, id);
  let gate = { ready: false, reason: "host_busy", message: "GPUコーディネーターがGPUを使用中のため、Irodoriの起動を待っています。" };
  const calls = [];
  const operations = {
    ensureTts: async () => { calls.push("ensure"); return gate; },
    stopTts: async () => { calls.push("stop"); return { stopped: true, reason: "no_unfinished_jobs" }; },
    generateSegmentAudio: async (jobId) => {
      calls.push("tts");
      const file = path.join(stateRoot, jobId, "job.json");
      const job = JSON.parse(fs.readFileSync(file, "utf8"));
      job.status = "completed"; job.current_stage = "completed";
      fs.writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`);
    },
  };
  let outcome = await runOne(config, operations);
  assert.deepEqual(outcome, { job_id: id, outcome: "waiting_for_tts", reason: "host_busy" });
  let job = readJob(stateRoot, id);
  assert.equal(job.status, "waiting_for_tts_service");
  assert.equal(job.tts_wait.reason, "host_busy");
  assert.equal(job.error, null);
  assert.equal(job.segments[0].audio.status, "pending");
  assert.equal(fs.existsSync(path.join(stateRoot, id, ".worker-state.json")), false, "waiting must not count as a failure");
  assert.equal(job.history.filter((entry) => entry.stage === "waiting_for_tts_service").length, 1);

  // Re-checking in the next cycles does not rewrite the job or spam the history.
  const before = fs.readFileSync(path.join(stateRoot, id, "job.json"), "utf8");
  await runOne(config, operations); await runOne(config, operations);
  assert.equal(fs.readFileSync(path.join(stateRoot, id, "job.json"), "utf8"), before);
  assert.deepEqual(calls, ["ensure", "ensure", "ensure"]);

  // The waiting state is visible through the existing status DTO.
  let status = getManualJobStatus(stateRoot, id);
  assert.equal(status.status, "waiting_for_tts_service");
  assert.match(status.status_label, /Irodori音声サービス待ち（GPUコーディネーターがGPU使用中）/);
  assert.match(status.current_stage_label, /GPUコーディネーターがGPU使用中/);
  assert.equal(status.tts_wait_reason, "host_busy");
  assert.match(status.tts_wait_message, /起動を待っています/);
  assert.match(status.retry_state_label, /待機中/);
  assert.equal(status.error_code, null);

  // A different reason is recorded once more.
  gate = { ready: false, reason: "gpu_busy", message: "GPUに実行中の計算プロセスがあるため、Irodoriの起動を待っています。" };
  await runOne(config, operations);
  job = readJob(stateRoot, id);
  assert.equal(job.tts_wait.reason, "gpu_busy");
  assert.equal(job.history.filter((entry) => entry.stage === "waiting_for_tts_service").length, 2);

  // Once Irodori is ready the job proceeds and the waiting note is removed.
  gate = { ready: true, started: true };
  calls.length = 0;
  await runOne(config, operations);
  assert.deepEqual(calls, ["ensure", "tts"]);
  job = readJob(stateRoot, id);
  assert.equal(job.tts_wait, undefined);
  status = getManualJobStatus(stateRoot, id);
  assert.equal(status.tts_wait_reason, null);

  // No unfinished job left: the worker asks for the stop.
  calls.length = 0;
  assert.deepEqual(await runOne(config, operations), { outcome: "idle", irodori: "stopped" });
  assert.deepEqual(calls, ["stop"]);

  // Feature switched off: neither start nor stop is attempted.
  calls.length = 0;
  assert.deepEqual(await runOne({ ...config, irodoriAutostart: false }, operations), { outcome: "idle" });
  const offId = "job_20260714T000100Z_ttsoff";
  writeAudioJob(stateRoot, offId);
  await advanceJob(offId, { ...config, irodoriAutostart: false }, operations);
  assert.deepEqual(calls, ["tts"]);

  fs.rmSync(temporary, { recursive: true, force: true });
  process.stdout.write("manual irodori autostart tests: ok\n");
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
