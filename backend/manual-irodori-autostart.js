"use strict";

// Starts Irodori-TTS only while a manual job needs it, and stops it again when
// no unfinished job is left. The worker stops only an instance it started
// itself: ownership is recorded with the unit's InvocationID, so an instance a
// person started (or restarted) by hand is never stopped from here.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const DEFAULT_UNIT = "irodori-tts.service";
const DEFAULT_START_TIMEOUT_MS = 120000;
const MARKER_NAME = ".irodori-autostart.json";

const WAIT_MESSAGES = {
  host_busy: "GPUコーディネーターがGPUを使用中のため、Irodoriの起動を待っています。",
  host_unknown: "GPUコーディネーターの状態を確認できないため、Irodoriの起動を待っています。",
  gpu_busy: "GPUに実行中の計算プロセスがあるため、Irodoriの起動を待っています。",
  gpu_unknown: "GPUの使用状況を確認できないため、Irodoriの起動を待っています。",
  start_failed: "Irodoriを起動できませんでした。次の周期で再確認します。",
  start_timeout: "Irodoriの起動完了を待っています。",
};

// Opt-in: the worker manages the Irodori unit only when this is switched on.
function autostartEnabled(env = process.env) {
  return ["1", "true", "on", "yes"].includes(String(env.MANUAL_IRODORI_AUTOSTART ?? "").trim().toLowerCase());
}

function run(command, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout }, (error, stdout, stderr) => {
      resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function fetchJson(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function defaultDependencies(options = {}) {
  const unit = options.unit || DEFAULT_UNIT;
  const irodoriUrl = String(options.irodoriUrl || "http://127.0.0.1:8088").replace(/\/+$/, "");
  // Optional: another service on the same machine that also loads models onto the GPU.
  // When no URL is configured only nvidia-smi decides whether the GPU is free.
  const hostUrl = String(options.hostUrl || "").replace(/\/+$/, "");
  return {
    async irodoriHealthy() {
      try { return (await fetch(`${irodoriUrl}/health`, { signal: AbortSignal.timeout(2500) })).ok; } catch { return false; }
    },
    async unitActive() {
      const state = (await run("systemctl", ["is-active", unit], 10000)).stdout.trim();
      return state === "active" || state === "activating";
    },
    async invocationId() {
      const result = await run("systemctl", ["show", unit, "-p", "InvocationID", "--value"], 10000);
      return result.code === 0 ? result.stdout.trim() : "";
    },
    async hostState() {
      if (!hostUrl) return null;
      const [resources, gpu] = await Promise.all([fetchJson(`${hostUrl}/api/resources`), fetchJson(`${hostUrl}/api/gpu`)]);
      return { resources, gpu };
    },
    async gpuComputeProcesses() {
      const result = await run("nvidia-smi", ["--query-compute-apps=pid", "--format=csv,noheader"], 15000);
      if (result.code !== 0) throw new Error("nvidia-smi failed");
      return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).length;
    },
    startUnit: () => run("systemctl", ["--no-ask-password", "start", unit], 60000),
    stopUnit: () => run("systemctl", ["--no-ask-password", "stop", unit], 120000),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

// Pure decision: may Irodori take the GPU right now?
function hostIsIdle(state) {
  const resources = state && state.resources;
  const gpu = state && state.gpu;
  if (!resources || !gpu || typeof gpu.model_states !== "object" || gpu.model_states === null) return false;
  const idle = (value) => value === "IDLE";
  const empty = (value) => value === null || value === undefined;
  return idle(resources.mode) && idle(resources.lifecycle)
    && empty(resources.active_job) && empty(resources.loaded_model)
    && empty(resources.running_model) && empty(resources.running_tool)
    && Number(resources.waiting_jobs || 0) === 0
    && empty(gpu.loaded_model) && empty(gpu.active_job) && empty(gpu.transition)
    && Number(gpu.queued || 0) === 0
    && Object.values(gpu.model_states).every((value) => value === "STOPPED");
}

async function startBlocker(dependencies) {
  let state;
  try { state = await dependencies.hostState(); } catch { return "host_unknown"; }
  // null = no coordinator configured, so there is nothing to ask.
  if (state !== null && !hostIsIdle(state)) return "host_busy";
  let processes;
  try { processes = await dependencies.gpuComputeProcesses(); } catch { return "gpu_unknown"; }
  if (!Number.isInteger(processes)) return "gpu_unknown";
  return processes > 0 ? "gpu_busy" : null;
}

function markerFile(stateRoot) { return path.join(stateRoot, MARKER_NAME); }

function readMarker(stateRoot) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerFile(stateRoot), "utf8"));
    return marker && typeof marker.invocation_id === "string" && marker.invocation_id ? marker : null;
  } catch { return null; }
}

function writeMarker(stateRoot, marker) {
  const file = markerFile(stateRoot);
  const temporary = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o660 });
  fs.renameSync(temporary, file);
}

function clearMarker(stateRoot) {
  try { fs.unlinkSync(markerFile(stateRoot)); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function waiting(reason) { return { ready: false, reason, message: WAIT_MESSAGES[reason] || WAIT_MESSAGES.start_failed }; }

async function waitForHealth(dependencies, timeoutMs) {
  const deadline = dependencies.now() + timeoutMs;
  while (dependencies.now() < deadline) {
    if (await dependencies.irodoriHealthy()) return true;
    await dependencies.sleep(1000);
  }
  return dependencies.irodoriHealthy();
}

// Called right before a job generates audio. { ready: true } means /health is ok.
async function ensureIrodori(options = {}) {
  const dependencies = options.dependencies || defaultDependencies(options);
  const timeoutMs = options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS;
  if (await dependencies.irodoriHealthy()) return { ready: true, started: false };
  if (await dependencies.unitActive()) {
    // Someone (or an earlier cycle) already started it; only wait for it.
    return await waitForHealth(dependencies, timeoutMs) ? { ready: true, started: false } : waiting("start_timeout");
  }
  const blocker = await startBlocker(dependencies);
  if (blocker) return waiting(blocker);
  const started = await dependencies.startUnit();
  if (started.code !== 0) return waiting("start_failed");
  const invocationId = await dependencies.invocationId();
  if (invocationId) writeMarker(options.stateRoot, { version: 1, unit: options.unit || DEFAULT_UNIT, invocation_id: invocationId, started_at: new Date(dependencies.now()).toISOString() });
  return await waitForHealth(dependencies, timeoutMs) ? { ready: true, started: true } : waiting("start_timeout");
}

// Called when no unfinished job is left. Stops only the instance this worker started.
async function stopIrodoriIfOwned(options = {}) {
  const marker = readMarker(options.stateRoot);
  if (!marker) return { stopped: false, reason: "not_owned" };
  const dependencies = options.dependencies || defaultDependencies(options);
  if (!(await dependencies.unitActive())) { clearMarker(options.stateRoot); return { stopped: false, reason: "already_stopped" }; }
  if ((await dependencies.invocationId()) !== marker.invocation_id) { clearMarker(options.stateRoot); return { stopped: false, reason: "restarted_by_someone_else" }; }
  const result = await dependencies.stopUnit();
  if (result.code !== 0) return { stopped: false, reason: "stop_failed" };
  clearMarker(options.stateRoot);
  return { stopped: true, reason: "no_unfinished_jobs" };
}

module.exports = {
  MARKER_NAME,
  WAIT_MESSAGES,
  autostartEnabled,
  defaultDependencies,
  ensureIrodori,
  hostIsIdle,
  startBlocker,
  stopIrodoriIfOwned,
};
