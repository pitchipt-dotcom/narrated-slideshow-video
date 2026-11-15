"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createManualJobServer } = require("../backend/manual-job-server");

const AUTH = { "tailscale-user-login": "tester@example.com" };
const ORIGIN = "https://manual.test";

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "image-review-http-"));
  const jobs = path.join(temporary, "jobs"); const library = path.join(temporary, "library");
  fs.mkdirSync(jobs); fs.mkdirSync(path.join(library, "metadata", "review"), { recursive: true }); fs.mkdirSync(path.join(library, "generated", "review"), { recursive: true });
  const id = "review_http_asset_001"; const bytes = Buffer.from("image");
  fs.writeFileSync(path.join(library, "generated", "review", `${id}.png`), bytes);
  fs.writeFileSync(path.join(library, "metadata", "review", `${id}.json`), JSON.stringify({
    asset_id: id, lifecycle: { state: "review", updated_at: "2026-07-26T00:00:00Z", history: [] },
    file: { relative_path: `generated/review/${id}.png`, sha256: crypto.createHash("sha256").update(bytes).digest("hex") },
    content: { title: "HTTP評価", tags: [] }, quality: { status: "pending" }, search: { enabled: true }, usage: { reuse_count: 0 },
  }));
  const server = createManualJobServer({ root: jobs, libraryRoot: library, allowedUsers: ["tester@example.com"], publicOrigin: ORIGIN });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const list = await fetch(`${base}/api/image-library-admin`, { headers: AUTH }); assert.equal(list.status, 200); assert.equal((await list.json()).items.length, 1);
    const noCsrf = await fetch(`${base}/api/image-library-admin/${id}`, { method: "PATCH", headers: { ...AUTH, "content-type": "application/json" }, body: "{}" });
    assert.equal(noCsrf.status, 403);
    const patched = await fetch(`${base}/api/image-library-admin/${id}`, {
      method: "PATCH", headers: { ...AUTH, origin: ORIGIN, "x-requested-with": "manual-video-ui", "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", note: "採用", tags: ["歩行"] }),
    });
    assert.equal(patched.status, 200); const result = await patched.json(); assert.equal(result.item.status, "approved"); assert.deepEqual(result.item.tags, ["歩行"]);
    const thumbnail = await fetch(`${base}${result.item.thumbnail_url}`, { headers: AUTH }); assert.equal(thumbnail.status, 200); assert.equal(await thumbnail.text(), "image");
    console.log("image library review server tests: ok");
  } finally {
    await new Promise((resolve) => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
