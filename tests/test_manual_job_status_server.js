"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createManualJobServer } = require("../backend/manual-job-server");
const TEST_ORIGIN = "https://manual.test";
const AUTH_HEADERS = { "tailscale-user-login": "tester@example.com" };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-status-server-test-"));
  const pronunciationDictionaryPath = path.join(root, "manual-pronunciation.json");
  const id = "job_20260714T160000Z_status_http"; const directory = path.join(root, id);
  fs.mkdirSync(path.join(directory, "video"), { recursive: true });
  const job = { version: 2, mode: "manual", job_id: id, status: "video_ready", current_stage: "video_ready", created_at: "2026-07-14T16:00:00Z", updated_at: "2026-07-14T16:01:00Z", input: { title: "HTTP結果", subtitle_text: "非表示台本", speech_text: "非表示読み" }, segments: [{ id: "seg_001", audio: { status: "generated" } }, { id: "seg_002", audio: { status: "generating" } }], output: { filename: "result.mp4" }, artifacts: { video_file: `/data/manual_jobs/${id}/video/result.mp4` }, error: null };
  fs.writeFileSync(path.join(directory, "job.json"), JSON.stringify(job)); fs.writeFileSync(path.join(directory, "video", "result.mp4"), "mp4-bytes");
  const cancelId = "job_20260714T160100Z_cancel_http"; const cancelDirectory = path.join(root, cancelId);
  fs.mkdirSync(cancelDirectory);
  fs.writeFileSync(path.join(cancelDirectory, "job.json"), JSON.stringify({
    ...job, job_id: cancelId, status: "queued", current_stage: "queued",
    output: { filename: null }, artifacts: { video_file: null },
  }));
  const errorLogs = [];
  fs.writeFileSync(pronunciationDictionaryPath, JSON.stringify({ version: 1, entries: [{ source: "東京都", reading: "とうきょうと" }] }));
  const server = createManualJobServer({ root, pronunciationDictionaryPath, allowedUsers: ["tester@example.com"], publicOrigin: TEST_ORIGIN, logError: (record) => errorLogs.push(record) });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const unauthenticated = await fetch(`${base}/api/manual-video-jobs?limit=20`); assert.equal(unauthenticated.status, 401);
    const wrongUser = await fetch(`${base}/api/manual-video-jobs?limit=20`, { headers: { "tailscale-user-login": "other@example.com" } }); assert.equal(wrongUser.status, 401);
    const health = await fetch(`${base}/health`); assert.equal(health.status, 200);
    const page = await fetch(`${base}/`, { headers: AUTH_HEADERS }); assert.equal(page.status, 200); assert.match(await page.text(), /動画生成/); assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const dictionary = await (await fetch(`${base}/api/manual-pronunciation-dictionary`, { headers: AUTH_HEADERS })).json();
    assert.equal(dictionary.dictionary.entries[0].source, "東京都");
    const testConversion = await fetch(`${base}/api/manual-pronunciation-dictionary/test`, {
      method: "POST", headers: { ...AUTH_HEADERS, origin: TEST_ORIGIN, "x-requested-with": "manual-video-ui", "content-type": "application/json" },
      body: JSON.stringify({ text: "東京都" }),
    });
    assert.equal(testConversion.status, 200); assert.equal((await testConversion.json()).result.text, "とうきょうと");
    const savedDictionary = await fetch(`${base}/api/manual-pronunciation-dictionary`, {
      method: "PUT", headers: { ...AUTH_HEADERS, origin: TEST_ORIGIN, "x-requested-with": "manual-video-ui", "content-type": "application/json" },
      body: JSON.stringify({ entries: [{ source: "市場", reading: "しじょう" }] }),
    });
    assert.equal(savedDictionary.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(pronunciationDictionaryPath, "utf8")).entries[0].reading, "しじょう");
    const list = await (await fetch(`${base}/api/manual-video-jobs?limit=20`, { headers: AUTH_HEADERS })).json();
    assert.equal(list.items.length, 2); assert.equal(JSON.stringify(list).includes("非表示台本"), false); assert.equal(JSON.stringify(list).includes("/data/"), false);
    const readyItem = list.items.find((item) => item.job_id === id);
    const cancelItem = list.items.find((item) => item.job_id === cancelId);
    assert.equal(readyItem.current_stage_label, "動画生成完了"); assert.equal(readyItem.next_stage_label, "保存"); assert.deepEqual(readyItem.segment_progress, { current: 2, total: 2 });
    assert.equal(readyItem.can_cancel, false); assert.equal(cancelItem.can_cancel, true);
    const cancelResponse = await fetch(`${base}/api/manual-video-jobs/${cancelId}/cancel`, {
      method: "POST", headers: { ...AUTH_HEADERS, origin: TEST_ORIGIN, "x-requested-with": "manual-video-ui" },
    });
    assert.equal(cancelResponse.status, 200); assert.equal((await cancelResponse.json()).status, "cancelled");
    assert.equal(JSON.parse(fs.readFileSync(path.join(cancelDirectory, "job.json"), "utf8")).status, "cancelled");
    const video = await fetch(`${base}${readyItem.video_url}`, { headers: AUTH_HEADERS }); assert.equal(video.status, 200); assert.equal(video.headers.get("content-type"), "video/mp4"); assert.equal(await video.text(), "mp4-bytes");
    assert.equal(video.headers.get("accept-ranges"), "bytes");
    const range = await fetch(`${base}${readyItem.video_url}`, { headers: { ...AUTH_HEADERS, range: "bytes=2-5" } });
    assert.equal(range.status, 206); assert.equal(range.headers.get("content-range"), "bytes 2-5/9"); assert.equal(range.headers.get("content-length"), "4"); assert.equal(await range.text(), "4-by");
    const suffix = await fetch(`${base}${readyItem.video_url}`, { headers: { ...AUTH_HEADERS, range: "bytes=-3" } });
    assert.equal(suffix.status, 206); assert.equal(await suffix.text(), "tes");
    const invalidRange = await fetch(`${base}${readyItem.video_url}`, { headers: { ...AUTH_HEADERS, range: "bytes=99-100" } });
    assert.equal(invalidRange.status, 416); assert.equal(invalidRange.headers.get("content-range"), "bytes */9");
    const headRange = await fetch(`${base}${readyItem.video_url}`, { method: "HEAD", headers: { ...AUTH_HEADERS, range: "bytes=0-1" } });
    assert.equal(headRange.status, 206); assert.equal(headRange.headers.get("content-length"), "2"); assert.equal(await headRange.text(), "");
    const download = await fetch(`${base}${readyItem.video_url}?download=true`, { headers: AUTH_HEADERS }); assert.match(download.headers.get("content-disposition"), /^attachment/);
    assert.equal(readyItem.video_url, `/video/job/${id}/view`);
    const manualDownload = await fetch(`${base}/video/job/${id}/download`, { headers: AUTH_HEADERS });
    assert.equal(manualDownload.status, 200);
    assert.match(manualDownload.headers.get("content-disposition"), /^attachment; filename="HTTP__\.mp4"; filename\*=UTF-8''HTTP%E7%B5%90%E6%9E%9C\.mp4$/);
    const unfinished = await fetch(`${base}/video/job/${cancelId}/view`, { headers: AUTH_HEADERS });
    assert.equal(unfinished.status, 409); assert.deepEqual(await unfinished.json(), { ok: false, code: "VIDEO_NOT_READY", message: "完成動画はまだ利用できません。" });
    const missing = await fetch(`${base}/video/job/job_20260714T170000Z_missing/view`, { headers: AUTH_HEADERS });
    assert.equal(missing.status, 404); assert.deepEqual(await missing.json(), { ok: false, code: "JOB_NOT_FOUND", message: "手動ジョブが見つかりません。" });
    const unauthenticatedVideo = await fetch(`${base}/video/job/${id}/view`);
    assert.equal(unauthenticatedVideo.status, 401);
    const csrfRejected = await fetch(`${base}/api/manual-video-jobs/${id}/regenerate`, { method: "POST", headers: AUTH_HEADERS }); assert.equal(csrfRejected.status, 403);
    const rawJob = await fetch(`${base}/api/manual-video-jobs/${id}`, { headers: AUTH_HEADERS }); assert.equal(rawJob.status, 404);
    assert(errorLogs.length >= 3); assert(errorLogs.every((record) => record.event === "manual_api_error" && !JSON.stringify(record).includes("非表示台本") && !JSON.stringify(record).includes("/data/")));
    console.log("manual job status server tests: ok");
  } finally {
    await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
