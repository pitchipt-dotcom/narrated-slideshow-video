"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getManualJobStatus, listManualJobStatuses, resolveManualVideo } = require("../backend/manual-job-status");

function job(id, status, updated) {
  return { version: 2, mode: "manual", job_id: id, status, current_stage: status, created_at: "2026-07-14T00:00:00.000Z", updated_at: updated,
    input: { title: `タイトル${id}`, subtitle_text: "秘密の台本", speech_text: "秘密の読み" }, output: { filename: status === "video_ready" ? "result.mp4" : null },
    artifacts: { video_file: status === "video_ready" ? `/data/manual_jobs/${id}/video/result.mp4` : null }, error: status === "failed" ? { stage: "segmenting", code: "SEGMENT_COUNT_MISMATCH", message: "字幕側2件、読み側3件です。\n内部改行", retryable: false, segment_id: null } : null };
}

(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-job-status-test-"));
  try {
    const ids = ["job_20260714T000000Z_old", "job_20260714T010000Z_ready", "job_20260714T020000Z_failed"];
    const states = ["queued", "video_ready", "failed"];
    ids.forEach((id, index) => {
      const directory = path.join(root, id); fs.mkdirSync(path.join(directory, "video"), { recursive: true });
      fs.writeFileSync(path.join(directory, "job.json"), JSON.stringify(job(id, states[index], `2026-07-14T0${index}:00:00.000Z`)));
      if (states[index] === "video_ready") fs.writeFileSync(path.join(directory, "video", "result.mp4"), "video-bytes");
    });
    const first = listManualJobStatuses(root, { limit: 2 }); assert.equal(first.items.length, 2); assert(first.next_cursor);
    assert.equal(first.items[0].status, "failed"); assert.equal(first.items[0].error_summary.includes("\n"), false);
    assert.equal(first.items[0].error_code, "SEGMENT_COUNT_MISMATCH"); assert.equal(first.items[0].error_retryable, false); assert.match(first.items[0].error_guidance, /改行・空行/);
    assert.equal(first.items[0].status_label, "エラーで停止"); assert.equal(first.items[0].error_stage_label, "台本を確認中"); assert.match(first.items[0].retry_state_label, /台本の修正が必要/); assert.match(first.items[0].next_stage_label, /新しく登録/);
    assert.equal(JSON.stringify(first).includes("秘密の台本"), false); assert.equal(JSON.stringify(first).includes("/data/"), false);
    const second = listManualJobStatuses(root, { limit: 2, cursor: first.next_cursor }); assert.equal(second.items.length, 1);
    let ready = getManualJobStatus(root, ids[1]); assert.equal(ready.video_url, `/video/job/${ids[1]}/view`); assert.equal(ready.mode_label, "手動モード");
    assert.equal(ready.current_stage_label, "動画生成完了"); assert.equal(ready.next_stage_label, "保存"); assert.equal(ready.retry_state_label, null);
    const readyFile = path.join(root, ids[1], "job.json"); const readyJob = JSON.parse(fs.readFileSync(readyFile, "utf8")); readyJob.archive = { status: "local_only" }; fs.writeFileSync(readyFile, JSON.stringify(readyJob));
    ready = getManualJobStatus(root, ids[1]); assert.equal(ready.next_stage_label, null);
    const genericFailedId = "job_20260714T025000Z_generic_failed"; const genericDirectory = path.join(root, genericFailedId); fs.mkdirSync(path.join(genericDirectory, "video"), { recursive: true });
    const genericFailed = job(genericFailedId, "failed", "2026-07-14T02:50:00.000Z"); genericFailed.error = { stage: "audio_ready", code: "MEDIA_COMMAND_FAILED", message: "音声処理失敗", retryable: false, segment_id: null }; fs.writeFileSync(path.join(genericDirectory, "job.json"), JSON.stringify(genericFailed));
    const genericDto = getManualJobStatus(root, genericFailedId); assert.equal(genericDto.error_stage_label, "音声時間取得・連結"); assert.equal(genericDto.retry_state_label, "自動再試行を停止"); assert.equal(genericDto.next_stage_label, "管理者がエラー内容を確認");
    for (const [suffix, status, expected, next] of [
      ["audio", "audio_generating", "Irodoriで音声生成中", "音声品質確認 → 音声結合 → 字幕生成 → FFmpeg動画生成"],
      ["subtitle", "subtitle_generating", "字幕生成中", "画像準備 → FFmpeg動画生成"],
      ["video", "video_generating", "FFmpegで動画生成中", "動画生成完了 → 保存"],
    ]) {
      const extraId = `job_20260714T030000Z_${suffix}`; const extraDirectory = path.join(root, extraId); fs.mkdirSync(path.join(extraDirectory, "video"), { recursive: true });
      fs.writeFileSync(path.join(extraDirectory, "job.json"), JSON.stringify(job(extraId, status, "2026-07-14T03:00:00.000Z")));
      const dto = getManualJobStatus(root, extraId); assert.equal(dto.current_stage_label, expected); assert.equal(dto.next_stage_label, next);
    }
    const qualityId = "job_20260714T040000Z_quality"; const qualityDirectory = path.join(root, qualityId); fs.mkdirSync(path.join(qualityDirectory, "video"), { recursive: true });
    const qualityJob = job(qualityId, "video_ready", "2026-07-14T04:00:00.000Z");
    qualityJob.voice_generation = { seed: 123456, reference_audio_used: false };
    qualityJob.audio_quality = { status: "attention", anomalies: [{ segment_id: "seg_003" }], regeneration_count: 1, max_regenerations: 2 };
    fs.writeFileSync(path.join(qualityDirectory, "job.json"), JSON.stringify(qualityJob)); fs.writeFileSync(path.join(qualityDirectory, "video", "result.mp4"), "video");
    const qualityDto = getManualJobStatus(root, qualityId); assert.equal(qualityDto.voice_seed, 123456); assert.match(qualityDto.voice_conditioning_label, /caption-only/); assert.deepEqual(qualityDto.audio_anomaly_segment_ids, ["seg_003"]); assert.equal(qualityDto.regenerate_action_label, "異常候補の音声だけ再生成");
    assert.equal(typeof qualityDto.is_stalled, "boolean"); assert(qualityDto.last_progress_at);
    const video = resolveManualVideo(root, ids[1]); assert.equal(fs.readFileSync(video.file, "utf8"), "video-bytes");
    assert.throws(() => resolveManualVideo(root, ids[0]), (error) => error.code === "VIDEO_NOT_READY");
    console.log("manual job status tests: ok");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})();
