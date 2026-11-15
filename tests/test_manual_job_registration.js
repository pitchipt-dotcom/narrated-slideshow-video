"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createManualJobServer } = require("../backend/manual-job-server");
const TEST_ORIGIN = "https://manual.test";
const AUTH_HEADERS = { "tailscale-user-login": "tester@example.com" };
const MUTATION_HEADERS = { ...AUTH_HEADERS, origin: TEST_ORIGIN, "x-requested-with": "manual-video-ui" };
const { RegistrationError, readManualJob, registerManualJob } = require("../backend/manual-job-registration");

const projectRoot = path.resolve(__dirname, "..");
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("minimal-test-image"),
]);

function input() {
  return {
    title: "登録テスト",
    subtitle_text: "正式名称を字幕に表示します。",
    speech_text: "せいしきめいしょうを、じまくにひょうじします。",
  };
}

function image(name = "安全な画像.png", type = "image/png", bytes = png) {
  return { name, type, bytes };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-jobs-test-"));
  try {
    const job = registerManualJob(input(), [image(), image("second.png")], {
      root,
      logicalRoot: "/data/slideshow/manual_jobs",
      now: new Date("2026-07-14T07:05:00.000Z"),
    });
    assert.equal(job.version, 2);
    assert.equal(job.mode, "manual");
    assert.equal(job.status, "queued");
    assert.equal(job.current_stage, "queued");
    assert.equal(Number.isInteger(job.voice_generation.seed), true);
    assert.equal(job.voice_generation.seed > 0, true);
    assert.equal(job.voice_generation.profile, job.voice_profile);
    assert.equal(job.voice_generation.profile_snapshot, null);
    assert.equal(job.segments.length, 0);
    assert.equal(job.images.length, 2);
    assert.equal(job.images[0].stored_filename, "image_001.png");
    assert.match(job.images[0].stored_path, /^\/data\/slideshow\/manual_jobs\/job_/);

    const jobDirectory = path.join(root, job.job_id);
    assert.deepEqual(fs.readFileSync(path.join(jobDirectory, "uploads/image_001.png")), png);
    assert.equal(fs.existsSync(path.join(jobDirectory, "audio")), true);
    assert.equal(fs.existsSync(path.join(jobDirectory, "subtitles")), true);
    assert.equal(fs.existsSync(path.join(jobDirectory, "video")), true);
    assert.equal(fs.readdirSync(jobDirectory).some((name) => name.includes(".tmp-")), false);
    assert.deepEqual(readManualJob(job.job_id, { root }), job);

    const untitled = registerManualJob({ ...input(), title: "" }, [image("untitled.png")], { root });
    assert.equal(untitled.input.title, "");
    assert.equal(untitled.output.filename, null);

    const schemaCheck = spawnSync("python3", ["-c", [
      "import json,sys",
      "from jsonschema import Draft202012Validator, FormatChecker",
      "schema=json.load(open(sys.argv[1], encoding='utf-8'))",
      "job=json.load(open(sys.argv[2], encoding='utf-8'))",
      "Draft202012Validator(schema, format_checker=FormatChecker()).validate(job)",
    ].join(";"), path.join(projectRoot, "schemas/manual-video-job.schema.json"), path.join(jobDirectory, "job.json")], { encoding: "utf8" });
    assert.equal(schemaCheck.status, 0, schemaCheck.stderr);

    assert.throws(
      () => registerManualJob(input(), [image("../escape.png")], { root }),
      (error) => error instanceof RegistrationError && error.code === "INVALID_FILENAME",
    );
    assert.equal(fs.existsSync(path.join(root, "escape.png")), false);
    assert.throws(
      () => registerManualJob(input(), [image("spoof.png", "image/jpeg")], { root }),
      (error) => error instanceof RegistrationError && error.code === "IMAGE_TYPE_MISMATCH",
    );
    assert.throws(
      () => readManualJob("../../jobs/other", { root }),
      (error) => error instanceof RegistrationError && error.code === "INVALID_JOB_ID",
    );

    const serverRoot = path.join(root, "http-registration");
    const server = createManualJobServer({ root: serverRoot, logicalRoot: "/data/slideshow/manual_jobs", allowedUsers: ["tester@example.com"], publicOrigin: TEST_ORIGIN });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const port = server.address().port;
      const form = new FormData();
      form.set("title", input().title);
      form.set("subtitle_text", input().subtitle_text);
      form.set("speech_text", input().speech_text);
      form.append("images", new Blob([png], { type: "image/png" }), "http-test.png");
      const response = await fetch(`http://127.0.0.1:${port}/api/manual-video-jobs`, { method: "POST", body: form, headers: MUTATION_HEADERS });
      assert.equal(response.status, 201);
      const registered = await response.json();
      assert.equal(registered.ok, true);
      assert.equal(registered.mode, "manual");

      const retrievedResponse = await fetch(`http://127.0.0.1:${port}/api/manual-video-jobs/${registered.job_id}/status`, { headers: AUTH_HEADERS });
      assert.equal(retrievedResponse.status, 200);
      const retrieved = await retrievedResponse.json();
      assert.equal(retrieved.job.job_id, registered.job_id);
      assert.equal(retrieved.job.title, input().title);
      assert.equal(JSON.stringify(retrieved).includes("stored_filename"), false);
    } finally {
      await closeServer(server);
    }

    console.log("manual job registration tests: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
