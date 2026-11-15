"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// jsdom is a dev dependency (npm install). JSDOM_PATH can point at another copy.
const { JSDOM } = require(process.env.JSDOM_PATH || "jsdom");

(async () => {

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "frontend/video-mode-entry/index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "frontend/video-mode-entry/app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "frontend/video-mode-entry/styles.css"), "utf8");
const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
const { window } = dom;
const { document } = window;

const fetchCalls = [];
window.fetch = async (...args) => {
  fetchCalls.push(args);
  if (String(args[0]).startsWith("/api/manual-image-library?")) {
    return { ok: true, json: async () => ({ ok: true, items: [{ asset_id: "common_test_asset_001", title: "承認済み画像", tags: ["test"], width: 1280, height: 720, thumbnail_url: "/api/manual-image-library/common_test_asset_001/thumbnail" }], next_cursor: null }) };
  }
  if (String(args[0]).startsWith("/api/manual-video-jobs?")) {
    return { ok: true, json: async () => ({ ok: true, items: [
      { job_id: "job_manual_status_001", mode: "manual", mode_label: "手動モード", title: "手動履歴", status: "video_ready", status_label: "動画生成完了", current_stage: "video_ready", current_stage_label: "動画生成完了", created_at: "2026-07-14T00:00:00Z", updated_at: "2026-07-14T00:01:00Z", segment_progress: { current: 2, total: 2 }, error_code: null, error_summary: null, retry_state_label: null, next_stage_label: "保存", video_url: "/api/manual-video-jobs/job_manual_status_001/video", can_regenerate: true },
      { job_id: "job_manual_status_002", mode: "manual", mode_label: "手動モード", title: "入力不一致", status: "failed", status_label: "エラーで停止", current_stage: "failed", current_stage_label: "エラーで停止", created_at: "2026-07-14T00:02:00Z", updated_at: "2026-07-14T00:03:00Z", segment_progress: null, error_code: "SEGMENT_COUNT_MISMATCH", error_stage: "segmenting", error_stage_label: "台本を確認中", error_retryable: false, error_summary: "字幕側2件、読み側3件です。", error_guidance: "改行を揃えてください。", retry_state_label: "台本の修正が必要（自動再試行しません）", next_stage_label: "台本を修正して新しく登録", video_url: null, can_regenerate: false },
      { job_id: "job_manual_status_003", mode: "manual", mode_label: "手動モード", title: "音声処理", status: "audio_generating", status_label: "Irodoriで音声生成中", current_stage: "audio_generating", current_stage_label: "Irodoriで音声生成中", created_at: "2026-07-14T00:04:00Z", updated_at: "2026-07-14T00:05:00Z", segment_progress: { current: 5, total: 12 }, error_code: null, error_summary: null, retry_state_label: "処理中", next_stage_label: "音声結合 → 字幕生成 → FFmpeg動画生成", video_url: null, can_regenerate: false },
    ], next_cursor: null }) };
  }
  if (String(args[0]).endsWith("/regenerate")) return { ok: true, json: async () => ({ ok: true, job_id: "job_regenerated_001", source_job_id: "job_manual_status_001", status: "images_ready", mode: "manual" }) };
  if (String(args[0]).endsWith("/image-settings") && (!args[1] || args[1].method !== "PATCH")) {
    return { ok: true, json: async () => ({ ok: true, job_id: "job_20260714T160000Z_abcdef123456", status: "queued", segments: [], images: [{ image_id: "image_001", source_image_id: "image_001", order: 1, label: "アップロード: one.png", source: "upload", requested_duration_seconds: null, segment_ids: [] }] }) };
  }
  if (String(args[0]).endsWith("/image-settings") && args[1] && args[1].method === "PATCH") {
    const payload = JSON.parse(args[1].body);
    return { ok: true, json: async () => ({ ok: true, job_id: "job_20260714T160000Z_abcdef123456", status: "queued", segments: [], images: payload.images.map((item, index) => ({ image_id: `image_00${index + 1}`, source_image_id: item.source_image_id, order: index + 1, label: "設定画像", source: "upload", requested_duration_seconds: item.requested_duration_seconds, segment_ids: item.segment_ids })) }) };
  }
  return { ok: true, json: async () => ({ ok: true, job_id: "job_20260714T160000Z_abcdef123456", status: "queued", mode: "manual" }) };
};
window.eval(script);

assert.equal(document.documentElement.lang, "ja");
assert.match(document.querySelector('meta[name="viewport"]').content, /width=device-width/);
assert.equal(document.querySelector('link[rel="manifest"]').getAttribute("href"), "/manifest.webmanifest");
assert.equal(document.querySelector("#manual-images").multiple, true);
assert.match(document.querySelector("#manual-images").accept, /image\/webp/);
assert.match(styles, /@media \(max-width: 420px\)/);
assert.match(styles, /\[hidden\] \{\s*display: none !important;/);
assert.match(document.querySelector(".input-guidance").textContent, /空行/);
assert.match(document.querySelector(".input-guidance").textContent, /---/);

// Three steps, in order, with nothing else to choose first.
assert.deepEqual([...document.querySelectorAll("#manual-video-form .step-number")].map((node) => node.textContent), ["1", "2", "3"]);
assert.equal(document.querySelector('#manual-video-form button[type="submit"]').textContent.trim(), "3動画を作る");
assert.equal(document.querySelector("#current-job").hidden, true);
// Detailed settings stay available, folded away.
for (const selector of ["#manual-speech-text", "#manual-title", "#pronunciation-dictionary-entries", "#image-settings-editor", "#manual-jobs-list", "#portal-status"]) {
  assert(document.querySelector(selector).closest("details"), `${selector} must be inside a folded section`);
}
assert.equal([...document.querySelectorAll("details")].some((node) => node.open), false);

const validate = window.VideoModeEntry.validateManualInput;
assert.equal(validate({}).ok, false);
assert.equal(validate({
  title: "テスト動画",
  subtitleText: "正式名称を表示します。",
  speechText: "せいしきめいしょうを、ひょうじします。",
  files: [{ name: "one.png", type: "image/png", size: 1024 }],
}).ok, true);
assert.equal(validate({ title: "テスト", subtitleText: "字幕", speechText: "よみ", files: [], libraryAssetIds: ["common_test_asset_001"] }).ok, true);
const mismatchValidation = validate({ title: "テスト", subtitleText: "字幕1。\n\n字幕2。", speechText: "よみ1。\n\nよみ2。\n\nよみ3。", files: [], libraryAssetIds: ["common_test_asset_001"] });
assert.equal(mismatchValidation.ok, false);
assert.match(mismatchValidation.errors.join(" "), /字幕側2件、読み側3件/);
const matchingStructure = window.VideoModeEntry.analyzeScriptStructure("字幕1。\n\n字幕2。", "よみ1。\n\nよみ2。");
assert.equal(matchingStructure.ok, true);
assert.equal(matchingStructure.subtitleCount, 2);
assert.equal(matchingStructure.speechCount, 2);
assert.equal(matchingStructure.message, null);
const separatorMismatch = window.VideoModeEntry.analyzeScriptStructure("字幕1。\n---\n字幕2。", "よみ1。\nよみ2。");
assert.equal(separatorMismatch.ok, false);
assert.match(separatorMismatch.message, /空行や ---/);
assert.equal(validate({
  title: "テスト動画",
  subtitleText: "字幕",
  speechText: "よみ",
  files: [{ name: "bad.gif", type: "image/gif", size: 1024 }],
}).ok, false);

const form = document.querySelector("#manual-video-form");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
await tick(); await tick();
// The library is loaded on open, without pressing anything.
assert(fetchCalls.some((call) => String(call[0]).startsWith("/api/manual-image-library?")));
const libraryCheckbox = document.querySelector('[data-library-asset-id="common_test_asset_001"]');
assert(libraryCheckbox);

fetchCalls.length = 0;
const emptyResult = await window.VideoModeEntry.submitManualForm(form);
assert.equal(emptyResult.ok, false);
assert.equal(document.querySelector("#manual-form-errors").hidden, false);
assert.match(document.querySelector("#manual-form-errors").textContent, /台本を入力してください/);
assert.match(document.querySelector("#manual-form-errors").textContent, /画像を1枚以上選んでください/);
assert.doesNotMatch(document.querySelector("#manual-form-errors").textContent, /読み上げ用台本/);
assert.equal(fetchCalls.length, 0);

// Step 1: tap a library image.
libraryCheckbox.click();
assert.equal(window.VideoModeEntry.selectedLibraryAssets.size, 1);
assert.match(document.querySelector("#selection-summary").textContent, /選択中 1枚/);
assert.equal(libraryCheckbox.closest(".library-card").querySelector(".library-order").textContent, "1");

// Step 2: paste one script. Step 3: make. The script is sent as both texts.
form.elements.subtitle_text.value = "正式名称を表示します。";
form.elements.subtitle_text.dispatchEvent(new window.Event("input"));
assert.equal(document.querySelector("#script-structure-status").hidden, true);
assert.equal(window.VideoModeEntry.effectiveSpeechText("字幕", "  "), "字幕");
assert.equal(window.VideoModeEntry.effectiveSpeechText("字幕", "よみ"), "よみ");
let statusCalls = 0;
const statusJobs = [
  { job_id: "job_20260714T160000Z_abcdef123456", title: "テスト動画", status: "waiting_for_tts_service", status_label: "Irodori音声サービス待ち（GPUコーディネーターがGPU使用中）", current_stage_label: "Irodori音声サービス待ち（GPUコーディネーターがGPU使用中）", tts_wait_reason: "host_busy", tts_wait_message: "GPUコーディネーターがGPUを使用中のため、Irodoriの起動を待っています。", can_cancel: true, video_url: null },
  { job_id: "job_20260714T160000Z_abcdef123456", title: "テスト動画", status: "audio_generating", status_label: "Irodoriで音声生成中", current_stage_label: "Irodoriで音声生成中", segment_progress: { current: 1, total: 3, unit: "block" }, can_cancel: true, video_url: null },
  { job_id: "job_20260714T160000Z_abcdef123456", title: "テスト動画", status: "video_ready", status_label: "動画生成完了", current_stage_label: "動画生成完了", can_cancel: false, video_url: "/video/job/job_20260714T160000Z_abcdef123456/view" },
];
const baseFetch = window.fetch;
window.fetch = async (...args) => {
  if (String(args[0]).endsWith("/status")) {
    fetchCalls.push(args);
    const job = statusJobs[Math.min(statusCalls, statusJobs.length - 1)]; statusCalls += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, job }) };
  }
  return baseFetch(...args);
};
const submitted = await window.VideoModeEntry.submitManualForm(form);
assert.equal(submitted.ok, true);
const postCall = fetchCalls.find((call) => call[0] === "/api/manual-video-jobs");
assert(postCall);
assert.equal(postCall[1].method, "POST");
assert.equal(postCall[1].headers["x-requested-with"], "manual-video-ui");
assert.equal(postCall[1].body.get("subtitle_text"), "正式名称を表示します。");
assert.equal(postCall[1].body.get("speech_text"), "正式名称を表示します。");
assert.deepEqual(postCall[1].body.getAll("library_asset_ids"), ["common_test_asset_001"]);
assert.equal(document.querySelector("#manual-form-status").dataset.jobId, "job_20260714T160000Z_abcdef123456");

// Progress is shown without pressing anything: waiting (with the reason) ...
const current = document.querySelector("#current-job");
const stepClasses = () => [...document.querySelectorAll("#current-job-steps li")].map((node) => (node.classList.contains("is-done") ? "done" : node.classList.contains("is-current") ? "current" : "todo"));
assert.equal(current.hidden, false);
assert.equal(current.dataset.state, "running");
assert.match(document.querySelector("#current-job-label").textContent, /Irodori音声サービス待ち（GPUコーディネーターがGPU使用中）/);
assert.match(document.querySelector("#current-job-detail").textContent, /起動を待っています/);
assert.deepEqual(stepClasses(), ["current", "todo", "todo", "todo"]);
assert.equal(document.querySelector("#current-job-video").hidden, true);
assert.equal(document.querySelector("#current-job-cancel").hidden, false);
assert.equal(window.localStorage.getItem("manual-video-current-job"), "job_20260714T160000Z_abcdef123456");
// ... audio ...
await window.VideoModeEntry.pollCurrentJob();
assert.match(document.querySelector("#current-job-label").textContent, /音声生成中/);
assert.match(document.querySelector("#current-job-detail").textContent, /音声 1 \/ 3ブロック/);
assert.deepEqual(stepClasses(), ["done", "current", "todo", "todo"]);
// ... done: play and save right there, and polling stops.
await window.VideoModeEntry.pollCurrentJob();
assert.equal(current.dataset.state, "done");
assert.deepEqual(stepClasses(), ["done", "done", "done", "done"]);
const video = document.querySelector("#current-job-video");
assert.equal(video.hidden, false);
assert.equal(video.getAttribute("src"), "/video/job/job_20260714T160000Z_abcdef123456/view");
assert.equal(document.querySelector("#current-job-save").getAttribute("href"), "/video/job/job_20260714T160000Z_abcdef123456/view?download=true");
assert.equal(document.querySelector("#current-job-save").hidden, false);
assert.equal(document.querySelector("#current-job-new").hidden, false);
assert.equal(document.querySelector("#current-job-cancel").hidden, true);
const callsWhenDone = statusCalls;
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(statusCalls, callsWhenDone);
assert.equal(window.VideoModeEntry.progressStep({ status: "failed" }), -1);
assert.equal(window.VideoModeEntry.progressStep({ status: "images_ready" }), 2);

// Folded detail settings still work.
assert.equal(document.querySelector("#image-settings-editor").hidden, false);
assert.equal(window.VideoModeEntry.imageSettingItems.length, 1);
document.querySelector(".image-setting-controls button:nth-child(3)").click();
assert.equal(window.VideoModeEntry.imageSettingItems.length, 2);
await window.VideoModeEntry.saveImageSettings();
const patchCall = fetchCalls.find((call) => call[1] && call[1].method === "PATCH");
assert(patchCall);
assert.equal(patchCall[1].headers["x-requested-with"], "manual-video-ui");
assert.equal(JSON.parse(patchCall[1].body).images.length, 2);

// A separate reading script is checked against the subtitle script.
form.elements.speech_text.value = "せいしきめいしょうを、ひょうじします。";
form.elements.speech_text.dispatchEvent(new window.Event("input"));
assert.equal(document.querySelector("#script-structure-status").hidden, false);
assert.match(document.querySelector("#script-structure-status").textContent, /一致しています/);

// History (folded) keeps its existing content.
await window.VideoModeEntry.loadManualJobs(false);
assert.match(document.querySelector("#manual-jobs-list").textContent, /動画生成完了/);
assert.match(document.querySelector("#manual-jobs-list").textContent, /Irodoriで音声生成中/);
assert.match(document.querySelector("#manual-jobs-list").textContent, /SEGMENT_COUNT_MISMATCH/);
assert.match(document.querySelector("#manual-jobs-list").textContent, /この素材で再生成/);

// "Make another" returns to an empty form.
document.querySelector("#current-job-new").click();
assert.equal(current.hidden, true);
assert.equal(window.VideoModeEntry.selectedLibraryAssets.size, 0);
assert.equal(form.elements.subtitle_text.value, "");
assert.equal(window.localStorage.getItem("manual-video-current-job"), null);

console.log("video-mode-entry tests: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
