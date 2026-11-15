"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createManualJobServer } = require("../backend/manual-job-server");
const TEST_ORIGIN = "https://manual.test";
const AUTH_HEADERS = { "tailscale-user-login": "tester@example.com" };
const MUTATION_HEADERS = { ...AUTH_HEADERS, origin: TEST_ORIGIN, "x-requested-with": "manual-video-ui" };

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "manual-job-library-selection-"));
  const jobs = path.join(temporary, "jobs");
  const library = path.join(temporary, "library");
  const assetId = "common_http_asset_001";
  const relativePath = `assets/common/test/${assetId}.png`;
  fs.mkdirSync(jobs);
  fs.mkdirSync(path.join(library, "metadata", "common"), { recursive: true });
  fs.mkdirSync(path.join(library, "assets", "common", "test"), { recursive: true });
  fs.writeFileSync(path.join(library, relativePath), Buffer.from("approved-image"));
  fs.writeFileSync(path.join(library, "metadata", "common", `${assetId}.json`), JSON.stringify({
    asset_id: assetId, lifecycle: { state: "common" }, quality: { status: "approved" }, search: { enabled: true }, rights: { commercial_use: true },
    file: { relative_path: relativePath, sha256: "a".repeat(64), width: 1280, height: 720, mime_type: "image/png" }, content: { title: "HTTP承認画像", tags: ["test"] },
  }));
  const server = createManualJobServer({ root: jobs, logicalRoot: "/data/manual_jobs", libraryRoot: library, libraryLogicalRoot: "/data/image_library", allowedUsers: ["tester@example.com"], publicOrigin: TEST_ORIGIN });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const listResponse = await fetch(`${base}/api/manual-image-library?limit=12`, { headers: AUTH_HEADERS });
    const list = await listResponse.json();
    assert.equal(list.items.length, 1);
    assert.equal(JSON.stringify(list).includes("assets/common"), false);
    const thumbnail = await fetch(`${base}${list.items[0].thumbnail_url}`, { headers: AUTH_HEADERS });
    assert.equal(thumbnail.status, 200);
    assert.equal(await thumbnail.text(), "approved-image");

    const form = new FormData();
    form.set("title", "ライブラリだけで登録");
    form.set("subtitle_text", "表示文");
    form.set("speech_text", "よみぶん");
    form.append("library_asset_ids", assetId);
    const response = await fetch(`${base}/api/manual-video-jobs`, { method: "POST", body: form, headers: MUTATION_HEADERS });
    assert.equal(response.status, 201);
    const registered = await response.json();
    const job = JSON.parse(fs.readFileSync(path.join(jobs, registered.job_id, "job.json"), "utf8"));
    assert.equal(job.images.length, 1);
    assert.equal(job.images[0].source, "library");
    assert.equal(job.images[0].library_asset_id, assetId);
    assert.equal(job.images[0].stored_path, `/data/image_library/${relativePath}`);
    assert.equal(fs.readdirSync(path.join(jobs, registered.job_id, "uploads")).length, 0);
    const settingsResponse = await fetch(`${base}/api/manual-video-jobs/${registered.job_id}/image-settings`, { headers: AUTH_HEADERS });
    const settings = await settingsResponse.json();
    assert.equal(settings.images.length, 1);
    assert.equal(JSON.stringify(settings).includes("stored_path"), false);
    const updateResponse = await fetch(`${base}/api/manual-video-jobs/${registered.job_id}/image-settings`, {
      method: "PATCH", headers: { ...MUTATION_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ images: [
        { source_image_id: "image_001", requested_duration_seconds: null, segment_ids: [] },
        { source_image_id: "image_001", requested_duration_seconds: null, segment_ids: [] },
      ] }),
    });
    assert.equal(updateResponse.status, 200);
    const updatedSettings = await updateResponse.json();
    assert.equal(updatedSettings.images.length, 2);
    assert.equal(new Set(updatedSettings.images.map((item) => item.image_id)).size, 2);
    console.log("manual job library selection tests: ok");
  } finally {
    await closeServer(server);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
