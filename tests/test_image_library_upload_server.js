"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createManualJobServer } = require("../backend/manual-job-server");

const AUTH = { "tailscale-user-login": "tester@example.com", origin: "https://manual.test", "x-requested-with": "manual-video-ui" };

function fixture(file, color) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=320x480:d=0.1`, "-frames:v", "1", file]);
  if (result.status !== 0) throw new Error("fixture failed");
  return fs.readFileSync(file);
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "image-upload-http-"));
  const jobs = path.join(temporary, "jobs"); const library = path.join(temporary, "library");
  fs.mkdirSync(jobs); fs.mkdirSync(path.join(library, "metadata", "review"), { recursive: true }); fs.mkdirSync(path.join(library, "generated", "review"), { recursive: true });
  const first = fixture(path.join(temporary, "first.jpg"), "red"); const second = fixture(path.join(temporary, "second.jpg"), "blue");
  const server = createManualJobServer({ root: jobs, libraryRoot: library, allowedUsers: ["tester@example.com"], publicOrigin: "https://manual.test" });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const form = new FormData();
    form.append("images", new File([first], "スマホ一.jpg", { type: "image/jpeg" }));
    form.append("images", new File([second], "スマホ二.jpg", { type: "image/jpeg" }));
    form.append("tags", "スマホ, 複数"); form.append("note", "Android相当"); form.append("rights_confirmed", "true");
    const uploaded = await fetch(`${base}/api/image-library-admin/upload`, { method: "POST", headers: AUTH, body: form });
    assert.equal(uploaded.status, 201); const result = await uploaded.json(); assert.equal(result.registered, 2); assert.equal(result.duplicates, 0);
    const duplicateForm = new FormData(); duplicateForm.append("images", new File([first], "別名.jpg", { type: "image/jpeg" })); duplicateForm.append("rights_confirmed", "true");
    const duplicated = await fetch(`${base}/api/image-library-admin/upload`, { method: "POST", headers: AUTH, body: duplicateForm });
    assert.equal(duplicated.status, 201); const duplicate = await duplicated.json(); assert.equal(duplicate.registered, 0); assert.equal(duplicate.duplicates, 1);
    const invalidForm = new FormData(); invalidForm.append("images", new File([Buffer.from("MZ executable")], "bad.png", { type: "image/png" })); invalidForm.append("rights_confirmed", "true");
    const invalid = await fetch(`${base}/api/image-library-admin/upload`, { method: "POST", headers: AUTH, body: invalidForm });
    assert.equal(invalid.status, 415); assert.equal((await invalid.json()).code, "INVALID_IMAGE_CONTENT");
    console.log("image library upload server tests: ok");
  } finally {
    await new Promise((resolve) => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
