"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const TERMINAL_STATES = new Set(["completed", "cancelled", "manual_review_required", "video_ready"]);
const CANCEL_MARKER = ".cancel-requested";

class CancellationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "CancellationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o660, flag: "wx" });
  fs.renameSync(temporary, file);
}

function resolveJob(root, jobId) {
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new CancellationError("INVALID_JOB_ID", "ジョブIDが不正です。");
  const realRoot = fs.realpathSync(path.resolve(root));
  let directory;
  try { directory = fs.realpathSync(path.join(realRoot, jobId)); } catch { throw new CancellationError("JOB_NOT_FOUND", "手動ジョブが見つかりません。", 404); }
  if (!directory.startsWith(`${realRoot}${path.sep}`)) throw new CancellationError("UNSAFE_PATH", "手動ジョブルート外は操作できません。", 400);
  return { directory, jobFile: path.join(directory, "job.json"), marker: path.join(directory, CANCEL_MARKER) };
}

function finalizeCancellation(jobFile, marker) {
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  if (TERMINAL_STATES.has(job.status)) {
    try { fs.unlinkSync(marker); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { job, cancelled: job.status === "cancelled", already_terminal: true };
  }
  const now = new Date().toISOString();
  const previousStage = job.current_stage || job.status;
  job.status = "cancelled";
  job.current_stage = "cancelled";
  job.updated_at = now;
  job.error = null;
  job.history = [...(job.history || []), {
    at: now,
    stage: "cancelled",
    message: `${previousStage}で利用者がジョブを中断。生成済み成果物は保持`,
  }];
  atomicWriteJson(jobFile, job);
  try { fs.unlinkSync(marker); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { job, cancelled: true, already_terminal: false };
}

function requestManualJobCancellation(jobId, options = {}) {
  const { directory, jobFile, marker } = resolveJob(options.root, jobId);
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  if (TERMINAL_STATES.has(job.status)) throw new CancellationError("JOB_NOT_CANCELLABLE", "完了または中断済みのジョブは中断できません。", 409);
  const requestedAt = new Date().toISOString();
  try {
    fs.writeFileSync(marker, `${JSON.stringify({ requested_at: requestedAt })}\n`, { mode: 0o660, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (!fs.existsSync(path.join(directory, ".manual-worker.lock"))) {
    const result = finalizeCancellation(jobFile, marker);
    return { ...result, pending: false };
  }
  const lockText = fs.readFileSync(path.join(directory, ".manual-worker.lock"), "utf8").trim();
  const workerPid = /^[1-9][0-9]{0,9}$/.test(lockText) ? Number(lockText) : null;
  return { job, cancelled: false, pending: true, already_terminal: false, worker_pid: workerPid };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function processCommand(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0/gu, " ").trim(); } catch { return ""; }
}

function childPids(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    return text ? text.split(/\s+/u).map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

function descendantPids(pid) {
  const result = [];
  const visit = (parent) => {
    for (const child of childPids(parent)) {
      visit(child);
      result.push(child);
    }
  };
  visit(pid);
  return result;
}

function signalIfAlive(pid, signal) {
  try { process.kill(pid, signal); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function stopActiveWorker(workerPid, options = {}) {
  if (!processExists(workerPid)) return { stopped: true, worker_pid: workerPid, descendants: [] };
  const expectedWorkerScript = path.resolve(options.workerScript || path.join(__dirname, "manual-job-worker.js"));
  const command = processCommand(workerPid);
  if (!command.includes("/usr/bin/node") || !command.includes(expectedWorkerScript)) {
    throw new CancellationError("WORKER_PID_MISMATCH", "中断対象PIDが手動動画workerと一致しないため停止しませんでした。", 409);
  }
  const descendants = descendantPids(workerPid);
  for (const pid of descendants) signalIfAlive(pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, Number(options.graceMs || 300)));
  for (const pid of descendants) signalIfAlive(pid, "SIGKILL");
  // Restart=on-failureのsystemd unitに再起動させる。通常終了扱いになるSIGTERMは使わない。
  signalIfAlive(workerPid, "SIGKILL");
  return { stopped: true, worker_pid: workerPid, descendants };
}

function applyRequestedCancellation(directory, jobFile) {
  const marker = path.join(directory, CANCEL_MARKER);
  if (!fs.existsSync(marker)) return null;
  return finalizeCancellation(jobFile, marker);
}

function cancellationRequested(directory) {
  return fs.existsSync(path.join(directory, CANCEL_MARKER));
}

module.exports = {
  CANCEL_MARKER,
  CancellationError,
  applyRequestedCancellation,
  cancellationRequested,
  requestManualJobCancellation,
  stopActiveWorker,
};
