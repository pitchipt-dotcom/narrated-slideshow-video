"use strict";

const TERMINAL = new Set(["completed", "video_ready", "failed", "cancelled", "recovery_required"]);
const EXCLUDED_WAITING = new Set(["waiting_for_image_review", "manual_review_required", "recovery_required"]);
const TIMEOUT_MINUTES = {
  queued: 10,
  fetching: 15,
  suitability_review: 20,
  script_ready: 20,
  speech_text_ready: 10,
  waiting_for_tts_service: 15,
  audio_generating: 15,
  audio_chunk_in_progress: 15,
  audio_chunks_ready: 15,
  audio_ready: 15,
  subtitle_generating: 15,
  subtitle_ready: 15,
  image_search: 20,
  images_ready: 20,
  waiting_for_video_service: 15,
  video_generating: 20,
  quality_review: 20,
};

function stallStatus(job, now = new Date()) {
  const stage = String(job.current_stage || job.status || "unknown");
  const lastProgressAt = job.last_progress_at || job.stage_updated_at || job.updated_at || job.created_at || null;
  const timeoutMinutes = TIMEOUT_MINUTES[stage] || 30;
  const last = Date.parse(lastProgressAt || "");
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const staleMinutes = Number.isFinite(last) && Number.isFinite(current)
    ? Math.max(0, Math.floor((current - last) / 60000))
    : null;
  const isStalled = !TERMINAL.has(job.status) && !TERMINAL.has(stage)
    && !EXCLUDED_WAITING.has(job.status) && !EXCLUDED_WAITING.has(stage)
    && staleMinutes !== null && staleMinutes >= timeoutMinutes;
  return {
    is_stalled: isStalled,
    last_progress_at: lastProgressAt,
    stage_updated_at: job.stage_updated_at || job.updated_at || null,
    stale_minutes: staleMinutes,
    timeout_minutes: timeoutMinutes,
    stall_message: isStalled ? `停止の可能性あり（${staleMinutes}分更新なし）` : null,
  };
}

module.exports = { TIMEOUT_MINUTES, stallStatus };
