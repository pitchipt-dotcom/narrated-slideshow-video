"use strict";

(function () {
  const MAX_TITLE_LENGTH = 200;
  const MAX_SCRIPT_LENGTH = 20000;
  const MAX_IMAGE_COUNT = 20;
  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const selectedLibraryAssets = new Map();
  let libraryCursor = null;
  let editingJobId = null;
  let imageSettingItems = [];
  let manualJobsCursor = null;

  async function loadPortalStatus() {
    const container = document.querySelector("#portal-status");
    const latest = document.querySelector("[data-latest-video-link]");
    try {
      const response = await fetch("/api/portal-status", { credentials: "same-origin", headers: { accept: "application/json" } });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error("status unavailable");
      const labels = { manual_ui: "画面・API", irodori: "Irodori-TTS" };
      container.replaceChildren(...Object.entries(labels).map(([key, label]) => {
        const item = document.createElement("span");
        item.className = result.services[key] ? "service-ok" : "service-down";
        item.textContent = `${label}: ${result.services[key] ? "稼働中" : "停止中"}`;
        return item;
      }));
      if (latest && result.latest_manual_video) {
        latest.href = result.latest_manual_video.video_url;
        latest.hidden = false;
      }
    } catch {
      container.textContent = "稼働状態を取得できませんでした。";
    }
  }

  function trimBoundaryWhitespace(value) {
    return String(value).replace(/^\s+|\s+$/gu, "");
  }

  function hasExplicitDelimiter(text) {
    return /^[\t ]*===SEGMENT===[\t ]*$/mu.test(text);
  }

  function splitSentenceCount(text) {
    const parts = [];
    let start = 0;
    let index = 0;
    const ends = new Set(["。", "！", "？", "!", "?"]);
    const closers = new Set(["」", "』", "）", ")", "】", "]", "\"", "'"]);
    while (index < text.length) {
      if (!ends.has(text[index])) { index += 1; continue; }
      let end = index + 1;
      while (end < text.length && ends.has(text[end])) end += 1;
      while (end < text.length && closers.has(text[end])) end += 1;
      if (trimBoundaryWhitespace(text.slice(start, end))) parts.push(true);
      start = end;
      index = end;
    }
    if (trimBoundaryWhitespace(text.slice(start))) parts.push(true);
    return parts.length;
  }

  function scriptPartCount(text, explicit) {
    if (explicit) return text.split(/^[\t ]*===SEGMENT===[\t ]*$/mu).map(trimBoundaryWhitespace).filter(Boolean).length;
    const blocks = text.split(/\r?\n(?:[\t ]*\r?\n)+/u).map(trimBoundaryWhitespace);
    return blocks.length > 1 ? blocks.filter(Boolean).length : splitSentenceCount(text);
  }

  function visibleSeparatorCount(text) {
    return String(text || "").split(/\r?\n/u).filter((line) => /^\s*---\s*$/u.test(line)).length;
  }

  function analyzeScriptStructure(subtitleText, speechText) {
    const subtitle = String(subtitleText || "").trim();
    const speech = String(speechText || "").trim();
    const subtitleExplicit = hasExplicitDelimiter(subtitle);
    const speechExplicit = hasExplicitDelimiter(speech);
    const subtitleCount = subtitle ? scriptPartCount(subtitle, subtitleExplicit) : 0;
    const speechCount = speech ? scriptPartCount(speech, speechExplicit) : 0;
    if (!subtitle || !speech) return { ok: false, subtitleCount, speechCount, message: null };
    if (subtitleExplicit !== speechExplicit) {
      return { ok: false, subtitleCount, speechCount, message: "明示区切り行 ===SEGMENT=== は両方の台本で同じように使用してください。" };
    }
    if (visibleSeparatorCount(subtitle) !== visibleSeparatorCount(speech)) {
      return { ok: false, subtitleCount, speechCount, message: `台本の区切りが一致しません（字幕側${subtitleCount}件、読み側${speechCount}件）。空行や --- の数と位置を両方でそろえてください。` };
    }
    if (subtitleCount !== speechCount) {
      return {
        ok: false,
        subtitleCount,
        speechCount,
        message: `台本の分割数が一致しません（字幕側${subtitleCount}件、読み側${speechCount}件）。読みだけを直し、空行や ---、段落区切りは字幕側と同じ位置にしてください。`,
      };
    }
    return { ok: true, subtitleCount, speechCount, message: null };
  }

  function renderScriptStructureStatus(subtitleText, speechText) {
    const container = document.querySelector("#script-structure-status");
    const analysis = analyzeScriptStructure(subtitleText, speechText);
    if (!container) return analysis;
    container.hidden = !String(speechText || "").trim();
    container.classList.remove("form-message--success", "form-message--error");
    const lines = [
      `字幕台本：${analysis.subtitleCount}セグメント`,
      `読み上げ台本：${analysis.speechCount}セグメント`,
    ];
    if (!String(subtitleText || "").trim() || !String(speechText || "").trim()) {
      lines.push("両方の台本を入力すると一致を確認します。");
    } else if (analysis.ok) {
      container.classList.add("form-message--success");
      lines.push("一致しています。送信できます。");
    } else {
      container.classList.add("form-message--error");
      lines.push(analysis.message || "セグメント構造が一致していません。");
    }
    container.replaceChildren(...lines.map((line) => {
      const row = document.createElement("div"); row.textContent = line; return row;
    }));
    return analysis;
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("ja-JP") : String(value || "不明");
  }

  function validateManualInput(values) {
    const title = String(values.title || "").trim();
    const subtitleText = String(values.subtitleText || "").trim();
    const speechText = String(values.speechText || "").trim();
    const files = Array.from(values.files || []);
    const libraryAssetIds = Array.from(values.libraryAssetIds || []);
    const errors = [];

    if (title.length > MAX_TITLE_LENGTH) errors.push(`動画タイトルは${MAX_TITLE_LENGTH}文字以内で入力してください。`);

    if (!subtitleText) errors.push("台本を入力してください。");
    else if (subtitleText.length > MAX_SCRIPT_LENGTH) errors.push(`台本は${MAX_SCRIPT_LENGTH}文字以内で入力してください。`);

    if (!speechText) { if (subtitleText) errors.push("読み上げ用台本を入力してください。"); }
    else if (speechText.length > MAX_SCRIPT_LENGTH) errors.push(`読み上げ用台本は${MAX_SCRIPT_LENGTH}文字以内で入力してください。`);

    if (subtitleText && speechText) {
      const structure = analyzeScriptStructure(subtitleText, speechText);
      if (!structure.ok && structure.message) errors.push(structure.message);
    }

    if (files.length + libraryAssetIds.length === 0) errors.push("画像を1枚以上選んでください。");
    else if (files.length + libraryAssetIds.length > MAX_IMAGE_COUNT) errors.push(`画像は合計${MAX_IMAGE_COUNT}枚以内で選択してください。`);
    if (new Set(libraryAssetIds).size !== libraryAssetIds.length || libraryAssetIds.some((id) => !/^[a-z0-9][a-z0-9_-]{7,63}$/.test(String(id)))) {
      errors.push("ライブラリ画像の選択が不正です。");
    }

    for (const file of files.slice(0, MAX_IMAGE_COUNT)) {
      const name = String(file.name || "画像");
      if (!ALLOWED_IMAGE_TYPES.has(file.type)) errors.push(`${name}はJPEG・PNG・WebPではありません。`);
      if (Number(file.size || 0) > MAX_IMAGE_BYTES) errors.push(`${name}は20MBを超えています。`);
    }

    return { ok: errors.length === 0, errors };
  }

  function renderErrors(container, errors) {
    container.replaceChildren();
    if (!errors.length) {
      container.hidden = true;
      return;
    }
    const heading = document.createElement("strong");
    heading.textContent = "入力内容を確認してください。";
    const list = document.createElement("ul");
    for (const message of errors) {
      const item = document.createElement("li");
      item.textContent = message;
      list.appendChild(item);
    }
    container.append(heading, list);
    container.hidden = false;
  }

  // One script is enough: it is shown as subtitles and read aloud as is, unless
  // a separate reading script was entered in the folded section.
  function effectiveSpeechText(subtitleText, speechText) {
    return String(speechText || "").trim() ? speechText : subtitleText;
  }

  // ---- Current job: automatic progress, inline playback and save ----
  const CURRENT_JOB_KEY = "manual-video-current-job";
  const POLL_MS = 3000;
  let trackedJobId = null;
  let trackTimer = null;

  function remember(jobId) {
    try { if (jobId) window.localStorage.setItem(CURRENT_JOB_KEY, jobId); else window.localStorage.removeItem(CURRENT_JOB_KEY); } catch {}
  }

  function rememberedJob() {
    try { const value = window.localStorage.getItem(CURRENT_JOB_KEY); return /^job_[A-Za-z0-9_-]{1,120}$/.test(String(value || "")) ? value : null; } catch { return null; }
  }

  // 0 = waiting, 1 = audio, 2 = subtitles/video, 3 = done, -1 = stopped
  function progressStep(job) {
    const status = String(job.status || "");
    if (["video_ready", "completed", "archived"].includes(status)) return 3;
    if (["failed", "cancelled", "manual_review_required", "needs_input_correction"].includes(status)) return -1;
    if (["audio_generation", "audio_generating", "audio_quality_checking", "audio_ready", "audio_assembled"].includes(status)) return 1;
    if (["subtitle_generating", "subtitle_ready", "image_planning", "images_ready", "waiting_for_video_service", "video_generation", "video_generating"].includes(status)) return 2;
    return 0;
  }

  function jobFinished(job) {
    const step = progressStep(job);
    if (step === 3) return true;
    return step === -1 && !(job.status === "failed" && job.error_retryable === true);
  }

  function progressDetail(job) {
    if (job.tts_wait_message) return job.tts_wait_message;
    const progress = job.segment_progress;
    if (progressStep(job) === 1 && progress && Number.isInteger(progress.total) && progress.total > 0) {
      return `音声 ${progress.current} / ${progress.total}${progress.unit === "block" ? "ブロック" : "セグメント"}`;
    }
    if (job.is_stalled && job.stall_message) return job.stall_message;
    if (job.retry_state_label && job.status === "failed") return job.retry_state_label;
    return job.next_stage_label ? `次: ${job.next_stage_label}` : "";
  }

  function renderCurrentJob(job) {
    const section = document.querySelector("#current-job");
    if (!section) return;
    section.hidden = false;
    const step = progressStep(job);
    const done = step === 3;
    section.dataset.state = done ? "done" : (step === -1 ? "stopped" : "running");
    document.querySelector("#current-job-title").textContent = done ? "できました" : (step === -1 ? "止まりました" : "いま作っている動画");
    // Without a title the API falls back to the file name or job id; that is noise here.
    const name = String(job.title || "");
    const nameNode = document.querySelector("#current-job-name");
    nameNode.textContent = name; nameNode.hidden = !name || /^job_/.test(name) || /\.mp4$/.test(name);
    const steps = document.querySelectorAll("#current-job-steps li");
    steps.forEach((item, index) => {
      item.classList.toggle("is-done", step > index || done);
      item.classList.toggle("is-current", step === index && !done);
    });
    document.querySelector("#current-job-label").textContent = job.current_stage_label || job.status_label || "処理中";
    document.querySelector("#current-job-detail").textContent = done ? "" : progressDetail(job);
    const error = document.querySelector("#current-job-error");
    const errorText = [job.error_summary, job.error_guidance].filter(Boolean).join(" ");
    error.textContent = errorText; error.hidden = !errorText;

    const video = document.querySelector("#current-job-video");
    const save = document.querySelector("#current-job-save");
    if (done && job.video_url) {
      if (video.getAttribute("src") !== job.video_url) video.setAttribute("src", job.video_url);
      video.hidden = false;
      save.href = `${job.video_url}?download=true`; save.hidden = false;
    } else {
      video.hidden = true; video.removeAttribute("src");
      save.hidden = true;
    }
    document.querySelector("#current-job-new").hidden = !jobFinished(job);
    const cancel = document.querySelector("#current-job-cancel");
    cancel.hidden = !job.can_cancel || jobFinished(job);
    cancel.disabled = Boolean(job.cancellation_requested);
    cancel.textContent = job.cancellation_requested ? "取消中…" : "取消";
  }

  function stopTracking() {
    if (trackTimer) { window.clearTimeout(trackTimer); trackTimer = null; }
  }

  async function pollCurrentJob() {
    stopTracking();
    const jobId = trackedJobId;
    if (!jobId) return { ok: false };
    let finished = false; let result = { ok: false };
    try {
      const response = await fetch(`/api/manual-video-jobs/${encodeURIComponent(jobId)}/status`, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
      result = await response.json();
      if (trackedJobId !== jobId) return result;
      if (response.status === 404) { trackedJobId = null; remember(null); document.querySelector("#current-job").hidden = true; return result; }
      if (!response.ok || !result.ok) throw new Error(result.message || "進み具合を取得できませんでした。");
      renderCurrentJob(result.job);
      finished = jobFinished(result.job);
    } catch (error) {
      const detail = document.querySelector("#current-job-detail");
      if (detail) detail.textContent = "進み具合を取得できませんでした。自動で再確認します。";
    }
    if (!finished && trackedJobId === jobId && !document.hidden) trackTimer = window.setTimeout(pollCurrentJob, POLL_MS);
    return result;
  }

  function trackJob(jobId) {
    trackedJobId = jobId; remember(jobId);
    const section = document.querySelector("#current-job");
    if (section) {
      renderCurrentJob({ job_id: jobId, status: "queued", status_label: "受付済み", can_cancel: false });
      section.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }
    return pollCurrentJob();
  }

  async function cancelCurrentJob() {
    if (!trackedJobId || !window.confirm("この動画の作成を取り消しますか？")) return;
    const cancel = document.querySelector("#current-job-cancel");
    cancel.disabled = true; cancel.textContent = "取消中…";
    try {
      const response = await fetch(`/api/manual-video-jobs/${encodeURIComponent(trackedJobId)}/cancel`, { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "x-requested-with": "manual-video-ui" } });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "取り消せませんでした。");
    } catch (error) {
      document.querySelector("#current-job-detail").textContent = String(error && error.message ? error.message : error);
    }
    await pollCurrentJob();
  }

  function startAnother(form) {
    stopTracking(); trackedJobId = null; remember(null);
    const video = document.querySelector("#current-job-video");
    video.pause?.(); video.removeAttribute("src"); video.hidden = true;
    document.querySelector("#current-job").hidden = true;
    form.reset();
    selectedLibraryAssets.clear();
    for (const checkbox of document.querySelectorAll("[data-library-asset-id]")) checkbox.checked = false;
    renderSelectedLibrary();
    renderScriptStructureStatus("", "");
    const status = document.querySelector("#manual-form-status"); status.hidden = true; status.textContent = "";
    document.querySelector("#image-settings-editor").hidden = true;
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  }

  async function registerManualJob(values) {
    const formData = new FormData();
    formData.set("title", String(values.title || "").trim());
    formData.set("subtitle_text", String(values.subtitleText || "").trim());
    formData.set("speech_text", String(values.speechText || "").trim());
    for (const file of Array.from(values.files || [])) formData.append("images", file, file.name);
    for (const assetId of Array.from(values.libraryAssetIds || [])) formData.append("library_asset_ids", assetId);
    const response = await fetch("/api/manual-video-jobs", {
      method: "POST",
      body: formData,
      credentials: "same-origin",
      headers: { accept: "application/json", "x-requested-with": "manual-video-ui" },
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "手動ジョブを登録できませんでした。");
    return result;
  }

  async function submitManualForm(form) {
    const errors = document.querySelector("#manual-form-errors");
    const status = document.querySelector("#manual-form-status");
    const submitButton = form.querySelector('button[type="submit"]');
    const submitLabel = submitButton.lastChild && submitButton.lastChild.nodeType === 3 ? submitButton.lastChild : submitButton;
    const values = {
      title: form.elements.title.value,
      subtitleText: form.elements.subtitle_text.value,
      speechText: effectiveSpeechText(form.elements.subtitle_text.value, form.elements.speech_text.value),
      files: form.elements.images.files,
      libraryAssetIds: [...selectedLibraryAssets.keys()],
    };
    const validation = validateManualInput(values);
    renderErrors(errors, validation.errors);
    status.hidden = true;
    status.textContent = "";
    if (!validation.ok) {
      errors.focus?.();
      return { ok: false, validation: true };
    }

    submitButton.disabled = true;
    submitLabel.textContent = "受付中…";
    try {
      const result = await registerManualJob(values);
      status.textContent = "受け付けました。下に進み具合が出ます。";
      status.dataset.jobId = result.job_id;
      status.hidden = false;
      trackJob(result.job_id);
      await loadImageSettings(result.job_id);
      if (document.querySelector("#history-details")?.open) await loadManualJobs(false);
      return result;
    } catch (error) {
      renderErrors(errors, [String(error && error.message ? error.message : error)]);
      errors.focus?.();
      return { ok: false, registration: true };
    } finally {
      submitButton.disabled = false;
      submitLabel.textContent = "動画を作る";
    }
  }

  function renderManualJobs(items, append = false) {
    const list = document.querySelector("#manual-jobs-list");
    if (!append) list.replaceChildren();
    for (const job of items) {
      const card = document.createElement("article"); card.className = "manual-job-card";
      const mode = document.createElement("span"); mode.className = "status-badge status-badge--preview"; mode.textContent = job.mode_label;
      const title = document.createElement("h4"); title.textContent = job.title;
      const state = document.createElement("p"); state.className = `job-state job-state--${job.status}`; state.textContent = job.status_label;
      const stage = document.createElement("p"); stage.className = "job-stage"; stage.textContent = `現在: ${job.current_stage_label || job.status_label || "処理中"}`;
      if (job.segment_progress && Number.isInteger(job.segment_progress.total) && job.segment_progress.total > 0) {
        if (job.segment_progress.unit === "block") {
          stage.textContent += ` / 音声生成: ${job.segment_progress.current} / ${job.segment_progress.total}ブロック`;
          stage.textContent += ` / 字幕: ${job.segment_progress.subtitle_total}セグメント`;
          if (Array.isArray(job.segment_progress.subtitle_range)) stage.textContent += ` / 対応字幕: ${job.segment_progress.subtitle_range[0]}〜${job.segment_progress.subtitle_range[1]}`;
        } else {
          stage.textContent += ` / 進捗: ${job.segment_progress.current} / ${job.segment_progress.total}セグメント`;
        }
      }
      if (job.error_stage_label) stage.textContent += ` / エラー発生工程: ${job.error_stage_label}`;
      const time = document.createElement("small"); time.textContent = `作成: ${formatTimestamp(job.created_at)} / 更新: ${formatTimestamp(job.updated_at)}`;
      card.append(mode, title, state, stage, time);
      if (job.is_stalled) {
        const stalled = document.createElement("p");
        stalled.className = "job-stalled";
        stalled.textContent = `${job.stall_message} / 最終進捗: ${formatTimestamp(job.last_progress_at)}`;
        card.appendChild(stalled);
      }
      if (Number.isInteger(job.voice_seed)) {
        const voice = document.createElement("p");
        voice.className = "job-voice-settings";
        voice.textContent = `音声seed: ${job.voice_seed}${job.voice_conditioning_label ? ` / ${job.voice_conditioning_label}` : ""}`;
        card.appendChild(voice);
      }
      if (job.audio_quality_label) {
        const quality = document.createElement("p"); quality.className = "job-audio-quality"; quality.textContent = job.audio_quality_label; card.appendChild(quality);
      }
      if (Array.isArray(job.audio_anomaly_segment_ids) && job.audio_anomaly_segment_ids.length) {
        const anomalies = document.createElement("p"); anomalies.className = "job-audio-anomalies"; anomalies.textContent = `異常候補: ${job.audio_anomaly_segment_ids.join(", ")}`; card.appendChild(anomalies);
      }
      if (Array.isArray(job.audio_anomaly_block_ids) && job.audio_anomaly_block_ids.length) {
        const anomalies = document.createElement("p"); anomalies.className = "job-audio-anomalies"; anomalies.textContent = `異常音声ブロック: ${job.audio_anomaly_block_ids.join(", ")}`; card.appendChild(anomalies);
      }
      if (job.is_audio_partial_regeneration) {
        const regenerating = document.createElement("p"); regenerating.className = "job-audio-regenerating"; regenerating.textContent = "異常候補の音声を部分再生成中"; card.appendChild(regenerating);
      }
      if (job.retry_state_label) { const retryState = document.createElement("p"); retryState.className = "job-retry-state"; retryState.textContent = `状態: ${job.retry_state_label}`; card.appendChild(retryState); }
      if (job.next_stage_label) { const next = document.createElement("p"); next.className = "job-next-stage"; next.textContent = `次: ${job.next_stage_label}`; card.appendChild(next); }
      if (job.error_code || job.error_summary) {
        const error = document.createElement("p"); error.className = "job-error";
        const retry = job.error_retryable === false ? "（自動再試行しません）" : "";
        error.textContent = [job.error_code, job.error_summary, retry].filter(Boolean).join(": ");
        card.appendChild(error);
      }
      if (job.error_guidance) { const guidance = document.createElement("p"); guidance.className = "job-error-guidance"; guidance.textContent = job.error_guidance; card.appendChild(guidance); }
      if (job.video_url) {
        const actions = document.createElement("div"); actions.className = "job-actions";
        const play = document.createElement("a"); play.href = job.video_url; play.target = "_blank"; play.rel = "noopener"; play.textContent = "動画を再生";
        const download = document.createElement("a"); download.href = `${job.video_url}?download=true`; download.textContent = "保存";
        actions.append(play, download); card.appendChild(actions);
      }
      if (job.can_regenerate) {
        const actionLabel = job.regenerate_action_label || "この素材で再生成";
        const regenerate = document.createElement("button"); regenerate.type = "button"; regenerate.className = "regenerate-action"; regenerate.textContent = actionLabel;
        regenerate.addEventListener("click", async () => {
          regenerate.disabled = true; regenerate.textContent = "再生成job作成中…";
          try {
            const response = await fetch(`/api/manual-video-jobs/${encodeURIComponent(job.job_id)}/regenerate`, { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "x-requested-with": "manual-video-ui" } });
            const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.message || "再生成jobを作成できませんでした。");
            await loadManualJobs(false);
          } catch (error) { document.querySelector("#manual-jobs-message").textContent = String(error && error.message ? error.message : error); }
          finally { regenerate.disabled = false; regenerate.textContent = actionLabel; }
        });
        card.appendChild(regenerate);
      }
      if (job.can_cancel) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "cancel-job-action";
        cancel.textContent = job.cancellation_requested ? "中断処理中…" : "このジョブを中断";
        cancel.disabled = Boolean(job.cancellation_requested);
        cancel.addEventListener("click", async () => {
          if (!window.confirm(`「${job.title}」を中断しますか？生成済みファイルは削除されません。`)) return;
          cancel.disabled = true;
          cancel.textContent = "中断要求を送信中…";
          try {
            const response = await fetch(`/api/manual-video-jobs/${encodeURIComponent(job.job_id)}/cancel`, {
              method: "POST",
              credentials: "same-origin",
              headers: { accept: "application/json", "x-requested-with": "manual-video-ui" },
            });
            const result = await response.json();
            if (!response.ok || !result.ok) throw new Error(result.message || "ジョブを中断できませんでした。");
            await loadManualJobs(false);
          } catch (error) {
            document.querySelector("#manual-jobs-message").textContent = String(error && error.message ? error.message : error);
            cancel.disabled = false;
            cancel.textContent = "このジョブを中断";
          }
        });
        card.appendChild(cancel);
      }
      list.appendChild(card);
    }
  }

  async function loadManualJobs(append = false) {
    const message = document.querySelector("#manual-jobs-message"); const more = document.querySelector("#load-more-manual-jobs");
    const query = new URLSearchParams({ limit: "20" }); if (append && manualJobsCursor) query.set("cursor", manualJobsCursor);
    message.textContent = "履歴を読込中…";
    try {
      const response = await fetch(`/api/manual-video-jobs?${query}`, { credentials: "same-origin", headers: { accept: "application/json" } });
      const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.message || "手動ジョブ履歴を読み込めませんでした。");
      renderManualJobs(result.items || [], append); manualJobsCursor = result.next_cursor || null; more.hidden = !manualJobsCursor;
      message.textContent = result.items && result.items.length ? `${result.items.length}件の手動ジョブを表示しました。` : "手動ジョブはまだありません。";
      return result;
    } catch (error) { message.textContent = String(error && error.message ? error.message : error); return { ok: false }; }
  }

  let pronunciationEntries = [];

  function renderPronunciationEntries() {
    const container = document.querySelector("#pronunciation-dictionary-entries");
    if (!container) return;
    container.replaceChildren();
    pronunciationEntries.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "dictionary-entry";
      const source = document.createElement("input");
      source.type = "text"; source.maxLength = 100; source.placeholder = "漢字表記"; source.value = entry.source;
      source.setAttribute("aria-label", `${index + 1}件目の表記`);
      const reading = document.createElement("input");
      reading.type = "text"; reading.maxLength = 100; reading.placeholder = "読み"; reading.value = entry.reading;
      reading.setAttribute("aria-label", `${index + 1}件目の読み`);
      const remove = document.createElement("button");
      remove.type = "button"; remove.textContent = "削除"; remove.setAttribute("aria-label", `${entry.source || index + 1}を削除`);
      source.addEventListener("input", () => { pronunciationEntries[index].source = source.value; });
      reading.addEventListener("input", () => { pronunciationEntries[index].reading = reading.value; });
      remove.addEventListener("click", () => { pronunciationEntries.splice(index, 1); renderPronunciationEntries(); });
      row.append(source, reading, remove);
      container.appendChild(row);
    });
  }

  async function loadPronunciationDictionary() {
    const message = document.querySelector("#pronunciation-dictionary-message");
    message.textContent = "読み辞書を読込中…";
    try {
      const response = await fetch("/api/manual-pronunciation-dictionary", { credentials: "same-origin", headers: { accept: "application/json" } });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "読み辞書を読み込めませんでした。");
      pronunciationEntries = (result.dictionary.entries || []).map((entry) => ({ source: entry.source, reading: entry.reading }));
      renderPronunciationEntries();
      message.textContent = `${pronunciationEntries.length}件の読み辞書を読み込みました。`;
    } catch (error) {
      message.textContent = String(error && error.message ? error.message : error);
    }
  }

  async function savePronunciationDictionary() {
    const message = document.querySelector("#pronunciation-dictionary-message");
    message.textContent = "保存中…";
    try {
      const response = await fetch("/api/manual-pronunciation-dictionary", {
        method: "PUT", credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "manual-video-ui" },
        body: JSON.stringify({ entries: pronunciationEntries }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "読み辞書を保存できませんでした。");
      pronunciationEntries = result.dictionary.entries.map((entry) => ({ source: entry.source, reading: entry.reading }));
      renderPronunciationEntries();
      message.textContent = `${pronunciationEntries.length}件を保存しました。次のIrodori音声生成から適用されます。`;
    } catch (error) {
      message.textContent = String(error && error.message ? error.message : error);
    }
  }

  async function testPronunciationDictionary() {
    const input = document.querySelector("#pronunciation-test-input");
    const output = document.querySelector("#pronunciation-test-output");
    output.textContent = "変換中…";
    try {
      const response = await fetch("/api/manual-pronunciation-dictionary/test", {
        method: "POST", credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "manual-video-ui" },
        body: JSON.stringify({ text: input.value }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "変換テストに失敗しました。");
      const applied = result.result.applied.map((entry) => `${entry.source}→${entry.reading}（${entry.count}回）`).join("、");
      output.textContent = `${result.result.text}${applied ? `\n適用: ${applied}` : "\n適用語なし"}`;
    } catch (error) {
      output.textContent = String(error && error.message ? error.message : error);
    }
  }

  function renderImageSettingsEditor() {
    const editor = document.querySelector("#image-settings-editor");
    const list = document.querySelector("#image-settings-list");
    if (!editor || !list) return;
    editor.hidden = false;
    list.replaceChildren();
    imageSettingItems.forEach((item, index) => {
      const row = document.createElement("li");
      row.className = "image-setting-row";
      const title = document.createElement("strong");
      title.textContent = `${index + 1}. ${item.label}`;
      const controls = document.createElement("div");
      controls.className = "image-setting-controls";
      for (const [label, action, disabled] of [
        ["上へ", () => { [imageSettingItems[index - 1], imageSettingItems[index]] = [imageSettingItems[index], imageSettingItems[index - 1]]; renderImageSettingsEditor(); }, index === 0],
        ["下へ", () => { [imageSettingItems[index + 1], imageSettingItems[index]] = [imageSettingItems[index], imageSettingItems[index + 1]]; renderImageSettingsEditor(); }, index === imageSettingItems.length - 1],
        ["複製", () => { if (imageSettingItems.length < MAX_IMAGE_COUNT) imageSettingItems.splice(index + 1, 0, { ...item, segment_ids: [...item.segment_ids] }); renderImageSettingsEditor(); }, false],
        ["削除", () => { if (imageSettingItems.length > 1) imageSettingItems.splice(index, 1); renderImageSettingsEditor(); }, imageSettingItems.length === 1],
      ]) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.disabled = disabled; button.addEventListener("click", action); controls.appendChild(button);
      }
      const duration = document.createElement("label"); duration.textContent = "表示秒数";
      const durationInput = document.createElement("input"); durationInput.type = "number"; durationInput.min = "0.001"; durationInput.step = "0.001"; durationInput.value = item.requested_duration_seconds ?? "";
      durationInput.addEventListener("input", () => { item.requested_duration_seconds = durationInput.value; }); duration.appendChild(durationInput);
      const segments = document.createElement("label"); segments.textContent = "segment ID（カンマ区切り）";
      const segmentInput = document.createElement("input"); segmentInput.type = "text"; segmentInput.value = (item.segment_ids || []).join(",");
      segmentInput.addEventListener("input", () => { item.segment_ids = segmentInput.value.split(",").map((value) => value.trim()).filter(Boolean); }); segments.appendChild(segmentInput);
      row.append(title, controls, duration, segments);
      list.appendChild(row);
    });
  }

  async function loadImageSettings(jobId) {
    editingJobId = jobId;
    const message = document.querySelector("#image-settings-message");
    try {
      const response = await fetch(`/api/manual-video-jobs/${encodeURIComponent(jobId)}/image-settings`, { credentials: "same-origin", headers: { accept: "application/json" } });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "画像設定を読み込めませんでした。");
      imageSettingItems = (result.images || []).map((item) => ({ ...item, segment_ids: [...(item.segment_ids || [])] }));
      renderImageSettingsEditor();
      if (message) message.textContent = `${imageSettingItems.length}件の画像設定を読み込みました。`;
      return result;
    } catch (error) {
      if (message) message.textContent = String(error && error.message ? error.message : error);
      return { ok: false };
    }
  }

  async function saveImageSettings() {
    const message = document.querySelector("#image-settings-message");
    if (!editingJobId) return { ok: false };
    const images = imageSettingItems.map((item) => ({
      source_image_id: item.source_image_id,
      requested_duration_seconds: item.requested_duration_seconds === "" ? null : item.requested_duration_seconds,
      segment_ids: item.segment_ids || [],
    }));
    try {
      const response = await fetch(`/api/manual-video-jobs/${encodeURIComponent(editingJobId)}/image-settings`, {
        method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json", "x-requested-with": "manual-video-ui" }, body: JSON.stringify({ images }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "画像設定を保存できませんでした。");
      imageSettingItems = result.images.map((item) => ({ ...item, segment_ids: [...(item.segment_ids || [])] }));
      renderImageSettingsEditor();
      message.textContent = "画像設定を保存しました。";
      return result;
    } catch (error) {
      message.textContent = String(error && error.message ? error.message : error);
      return { ok: false };
    }
  }

  function renderSelectedLibrary() {
    const summary = document.querySelector("#selection-summary");
    const files = Array.from(document.querySelector("#manual-images")?.files || []);
    const upload = document.querySelector("#upload-summary");
    if (upload) upload.textContent = files.length ? `写真 ${files.length}枚: ${files.map((file) => file.name).join("、")}`.slice(0, 160) : "JPEG・PNG・WebP。ライブラリと合わせて20枚まで。";
    // Uploaded photos are used first, then library images in the order they were tapped.
    const order = new Map([...selectedLibraryAssets.keys()].map((assetId, index) => [assetId, files.length + index + 1]));
    for (const checkbox of document.querySelectorAll("[data-library-asset-id]")) {
      const badge = checkbox.closest(".library-card")?.querySelector(".library-order");
      if (badge) badge.textContent = order.has(checkbox.dataset.libraryAssetId) ? String(order.get(checkbox.dataset.libraryAssetId)) : "";
    }
    if (!summary) return;
    const total = files.length + selectedLibraryAssets.size;
    summary.textContent = total ? `選択中 ${total}枚（番号 = 使う順${files.length ? "。追加した写真が先" : ""}）` : "まだ選んでいません";
  }

  function renderLibraryAssets(items, append = false) {
    const grid = document.querySelector("#library-image-grid");
    if (!append) grid.replaceChildren();
    for (const asset of items) {
      const label = document.createElement("label");
      label.className = "library-card";
      const image = document.createElement("img");
      image.src = asset.thumbnail_url;
      image.alt = asset.title;
      image.loading = "lazy";
      image.width = 160;
      image.height = 100;
      const badge = document.createElement("b");
      badge.className = "library-order";
      badge.setAttribute("aria-hidden", "true");
      const row = document.createElement("span");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.libraryAssetId = asset.asset_id;
      checkbox.checked = selectedLibraryAssets.has(asset.asset_id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedLibraryAssets.set(asset.asset_id, asset);
        else selectedLibraryAssets.delete(asset.asset_id);
        renderSelectedLibrary();
      });
      const title = document.createElement("span");
      title.textContent = asset.title;
      row.append(checkbox, title);
      label.append(image, badge, row);
      grid.appendChild(label);
    }
  }

  async function loadLibraryPage(append = false) {
    const message = document.querySelector("#library-message");
    const more = document.querySelector("#load-more-library-images");
    message.textContent = "読込中…";
    const query = new URLSearchParams({ limit: "12" });
    if (append && libraryCursor) query.set("cursor", libraryCursor);
    try {
      const response = await fetch(`/api/manual-image-library?${query}`, { credentials: "same-origin", headers: { accept: "application/json" } });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "画像ライブラリを読み込めませんでした。");
      renderLibraryAssets(result.items || [], append);
      renderSelectedLibrary();
      libraryCursor = result.next_cursor || null;
      more.hidden = !libraryCursor;
      message.textContent = result.items && result.items.length ? "" : "ライブラリに使える画像はまだありません。写真を追加してください。";
      return result;
    } catch (error) {
      message.textContent = String(error && error.message ? error.message : error);
      return { ok: false };
    }
  }

  function init() {
    const form = document.querySelector("#manual-video-form");
    if (!form) return;

    // Secondary things load only when their folded section is opened.
    document.querySelector("#more-details")?.addEventListener("toggle", (event) => { if (event.target.open) loadPortalStatus(); });
    document.querySelector("#history-details")?.addEventListener("toggle", (event) => { if (event.target.open) { manualJobsCursor = null; loadManualJobs(false); } });
    form.elements.images.addEventListener("change", renderSelectedLibrary);
    document.querySelector("#current-job-cancel")?.addEventListener("click", cancelCurrentJob);
    document.querySelector("#current-job-new")?.addEventListener("click", () => startAnother(form));
    document.addEventListener("visibilitychange", () => { if (!document.hidden && trackedJobId) pollCurrentJob(); else stopTracking(); });

    for (const tab of document.querySelectorAll("[data-mode]")) {
      tab.addEventListener("click", () => setMode(tab.dataset.mode));
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await submitManualForm(form);
    });
    const subtitleInput = form.elements.subtitle_text;
    const speechInput = form.elements.speech_text;
    const updateScriptStructure = () => renderScriptStructureStatus(subtitleInput.value, speechInput.value);
    subtitleInput.addEventListener("input", updateScriptStructure);
    speechInput.addEventListener("input", updateScriptStructure);
    updateScriptStructure();
    document.querySelector("#load-library-images")?.addEventListener("click", () => { libraryCursor = null; loadLibraryPage(false); });
    document.querySelector("#load-more-library-images")?.addEventListener("click", () => loadLibraryPage(true));
    document.querySelector("#save-image-settings")?.addEventListener("click", saveImageSettings);
    document.querySelector("#load-manual-jobs")?.addEventListener("click", () => { manualJobsCursor = null; loadManualJobs(false); });
    document.querySelector("#load-more-manual-jobs")?.addEventListener("click", () => loadManualJobs(true));
    document.querySelector("#load-pronunciation-dictionary")?.addEventListener("click", loadPronunciationDictionary);
    document.querySelector("#add-pronunciation-entry")?.addEventListener("click", () => {
      pronunciationEntries.push({ source: "", reading: "" });
      renderPronunciationEntries();
    });
    document.querySelector("#save-pronunciation-dictionary")?.addEventListener("click", savePronunciationDictionary);
    document.querySelector("#test-pronunciation-dictionary")?.addEventListener("click", testPronunciationDictionary);
    loadPronunciationDictionary();
    renderSelectedLibrary();
    loadLibraryPage(false);
    const resumed = rememberedJob();
    if (resumed) { trackedJobId = resumed; pollCurrentJob(); }
  }

  window.VideoModeEntry = Object.freeze({
    validateManualInput,
    analyzeScriptStructure,
    renderScriptStructureStatus,
    registerManualJob,
    submitManualForm,
    loadLibraryPage,
    renderLibraryAssets,
    selectedLibraryAssets,
    loadImageSettings,
    saveImageSettings,
    get imageSettingItems() { return imageSettingItems; },
    loadManualJobs,
    renderManualJobs,
    trackJob,
    pollCurrentJob,
    renderCurrentJob,
    progressStep,
    effectiveSpeechText,
    loadPronunciationDictionary,
    savePronunciationDictionary,
    testPronunciationDictionary,
    renderPronunciationEntries,
  });
  init();

  // PWA: register the minimal app-shell worker (static screen parts only).
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  }
})();
