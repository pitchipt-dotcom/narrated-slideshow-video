"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  applyRequestedCancellation,
  requestManualJobCancellation,
  stopActiveWorker,
} = require("../backend/manual-job-cancellation");

function createJob(root, id) {
  const directory = path.join(root, id);
  fs.mkdirSync(directory);
  const job = {
    version: 2, mode: "manual", job_id: id, status: "audio_generating",
    current_stage: "audio_generating", created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), history: [], error: null,
  };
  fs.writeFileSync(path.join(directory, "job.json"), JSON.stringify(job));
  return directory;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-cancel-test-"));
  try {
    const immediateId = "job_cancel_immediate";
    const immediateDirectory = createJob(root, immediateId);
    const immediate = requestManualJobCancellation(immediateId, { root });
    assert.equal(immediate.pending, false);
    const cancelled = JSON.parse(fs.readFileSync(path.join(immediateDirectory, "job.json"), "utf8"));
    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.history.at(-1).message, /生成済み成果物は保持/);

    const activeId = "job_cancel_active";
    const activeDirectory = createJob(root, activeId);
    fs.writeFileSync(path.join(activeDirectory, ".manual-worker.lock"), "123\n");
    const requested = requestManualJobCancellation(activeId, { root });
    assert.equal(requested.pending, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(activeDirectory, "job.json"), "utf8")).status, "audio_generating");
    const applied = applyRequestedCancellation(activeDirectory, path.join(activeDirectory, "job.json"));
    assert.equal(applied.cancelled, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(activeDirectory, "job.json"), "utf8")).status, "cancelled");
    assert.equal(fs.existsSync(path.join(activeDirectory, ".cancel-requested")), false);

    const token = "/tmp/manual-job-worker-test-token.js";
    const worker = spawn("/usr/bin/node", [
      "-e",
      "require('node:child_process').spawn('/usr/bin/sleep',['30']);setInterval(()=>{},1000)",
      token,
    ], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopped = await stopActiveWorker(worker.pid, { workerScript: token, graceMs: 25 });
    assert.equal(stopped.stopped, true);
    assert(stopped.descendants.length >= 1);
    await new Promise((resolve) => worker.once("exit", resolve));
    console.log("manual job cancellation tests: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
