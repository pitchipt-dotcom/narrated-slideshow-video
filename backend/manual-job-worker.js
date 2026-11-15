"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { segmentAndSaveManualJob } = require("./manual-script-segmentation");
const { generateManualAudioBlock, generateManualSegmentAudio } = require("./manual-segment-audio-generation");
const { audioBlockConfig, hasAudioBlocks } = require("./manual-audio-blocks");
const { applyRequestedCancellation } = require("./manual-job-cancellation");
const { checkManualAudioQuality } = require("./manual-audio-quality");
const { assembleManualAudio } = require("./manual-audio-assembly");
const { generateManualSubtitles } = require("./manual-subtitle-generation");
const { planAndSaveManualImages } = require("./manual-image-timing");
const { generateManualVideo } = require("./manual-video-generation");
const { archiveManualArtifacts } = require("./manual-artifact-archive");
const { WAIT_MESSAGES, autostartEnabled, ensureIrodori, stopIrodoriIfOwned } = require("./manual-irodori-autostart");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const TERMINAL_STATES = new Set(["completed", "cancelled", "manual_review_required"]);
const DEFAULT_POLL_MS = 5000;
const DEFAULT_MAX_RETRIES = 3;

class ManualWorkerError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ManualWorkerError";
    this.code = code;
    this.retryable = options.retryable !== false;
    this.cause = options.cause;
  }
}

function requiredPath(value, label, create = false) {
  if (!value) throw new ManualWorkerError("ROOT_NOT_CONFIGURED", `${label}が設定されていません。`, { retryable: false });
  const resolved = path.resolve(value);
  if (create) fs.mkdirSync(resolved, { recursive: true, mode: 0o770 });
  try { return fs.realpathSync(resolved); }
  catch (error) { throw new ManualWorkerError("ROOT_UNAVAILABLE", `${label}を使用できません。`, { retryable: true, cause: error }); }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o660 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; }
    throw error;
  }
}

function safeJobDirectory(root, jobId) {
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new ManualWorkerError("INVALID_JOB_ID", "ジョブIDが不正です。", { retryable: false });
  const realRoot = requiredPath(root, "手動ジョブ保存先");
  const candidate = path.join(realRoot, jobId);
  const directory = fs.realpathSync(candidate);
  if (!directory.startsWith(`${realRoot}${path.sep}`)) throw new ManualWorkerError("UNSAFE_PATH", "手動ジョブルート外は処理できません。", { retryable: false });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new ManualWorkerError("UNSAFE_PATH", "シンボリックリンクのジョブは処理できません。", { retryable: false });
  const jobFile = path.join(directory, "job.json");
  if (!fs.lstatSync(jobFile).isFile() || fs.lstatSync(jobFile).isSymbolicLink()) throw new ManualWorkerError("INVALID_JOB_FILE", "job.jsonが不正です。", { retryable: false });
  return { directory, jobFile };
}

function workerStateFile(directory) { return path.join(directory, ".worker-state.json"); }

function loadWorkerState(directory) {
  const file = workerStateFile(directory);
  if (!fs.existsSync(file)) return { version: 1, failures: 0, last_error: null, updated_at: null };
  try {
    const state = readJson(file);
    return {
      version: 1,
      failures: Number.isInteger(state.failures) && state.failures >= 0 ? state.failures : 0,
      last_error: state.last_error || null,
      updated_at: state.updated_at || null,
    };
  } catch {
    return { version: 1, failures: 0, last_error: null, updated_at: null };
  }
}

function saveWorkerState(directory, state) { atomicWriteJson(workerStateFile(directory), state); }

function clearWorkerFailures(directory) {
  const state = loadWorkerState(directory);
  if (state.failures === 0 && !state.last_error) return;
  saveWorkerState(directory, { version: 1, failures: 0, last_error: null, updated_at: new Date().toISOString() });
}

function failureStage(job) {
  if (job.status === "queued") return "segmenting";
  return job.current_stage || job.status || "failed";
}

function publicFailureMessage(error) {
  if (error.code === "SEGMENT_COUNT_MISMATCH" && error.details) {
    const subtitleCount = Number(error.details.subtitle_count);
    const speechCount = Number(error.details.speech_count);
    if (Number.isInteger(subtitleCount) && Number.isInteger(speechCount)) {
      return `字幕側${subtitleCount}件、読み側${speechCount}件です。改行・空行・区切り行を両方で揃えてください。`;
    }
  }
  return String(error.message || "worker処理に失敗しました。").replace(/[\r\n]+/gu, " ").slice(0, 500);
}

function markWorkerFailure(jobFile, error, options = {}) {
  const job = readJson(jobFile);
  const existingSegmentId = job.error && job.error.segment_id;
  const existingAudioBlockId = job.error && job.error.audio_block_id;
  const now = new Date().toISOString();
  const stage = options.stage || (job.error && job.error.stage) || failureStage(job);
  const retryable = options.retryable === true;
  const exhausted = options.exhausted === true;
  const baseMessage = publicFailureMessage(error);
  job.status = "failed";
  job.current_stage = "failed";
  job.updated_at = now;
  job.error = {
    stage,
    code: error.code || "WORKER_ERROR",
    message: exhausted ? `${baseMessage} 自動再試行の上限に達しました。`.slice(0, 500) : baseMessage,
    retryable,
    segment_id: error.segmentId || existingSegmentId || null,
    ...(error.audioBlockId || existingAudioBlockId ? { audio_block_id: error.audioBlockId || existingAudioBlockId } : {}),
  };
  job.history = [...(job.history || []), { at: now, stage: "failed", message: retryable ? `${stage}で失敗・自動再試行待ち` : `${stage}で停止` }];
  atomicWriteJson(jobFile, job);
  return job;
}

function acquireJobLock(directory) {
  const file = path.join(directory, ".manual-worker.lock");
  const tryAcquire = () => {
    const descriptor = fs.openSync(file, "wx", 0o660);
    fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    return () => {
      try { fs.closeSync(descriptor); } finally { try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; } }
    };
  };
  try {
    return tryAcquire();
  } catch (error) {
    if (error.code === "EEXIST") {
      let owner = null;
      try {
        const value = fs.readFileSync(file, "utf8").trim();
        owner = /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : null;
      } catch {}
      let alive = false;
      if (owner) {
        try { process.kill(owner, 0); alive = true; } catch (checkError) { alive = checkError.code === "EPERM"; }
      }
      if (alive) return null;
      try { fs.unlinkSync(file); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") return null; }
      try { return tryAcquire(); } catch (retryError) { if (retryError.code === "EEXIST") return null; throw retryError; }
    }
    throw error;
  }
}

function defaultOperations() {
  return {
    segment: segmentAndSaveManualJob,
    generateAudioBlock: generateManualAudioBlock,
    generateSegmentAudio: generateManualSegmentAudio,
    checkAudioQuality: checkManualAudioQuality,
    assembleAudio: assembleManualAudio,
    generateSubtitles: generateManualSubtitles,
    planImages: planAndSaveManualImages,
    generateVideo: generateManualVideo,
    archive: archiveManualArtifacts,
    ensureTts: async (config) => {
      try { return await ensureIrodori(ttsAutostartOptions(config)); }
      catch { return { ready: false, reason: "start_failed", message: WAIT_MESSAGES.start_failed }; }
    },
    stopTts: async (config) => {
      try { return await stopIrodoriIfOwned(ttsAutostartOptions(config)); }
      catch { return { stopped: false, reason: "stop_failed" }; }
    },
  };
}

function ttsAutostartOptions(config) {
  return { stateRoot: config.jobsRoot, irodoriUrl: config.irodoriUrl, hostUrl: config.gpuCoordinatorUrl, unit: config.irodoriUnit };
}

const TTS_WAIT_REFRESH_MS = 60000;

// Keeps the job in the existing waiting_for_tts_service state while Irodori
// cannot be started yet. This is not a failure: the retry counter is untouched.
function markTtsWait(jobFile, gate) {
  const job = readJson(jobFile);
  const now = new Date();
  const same = job.status === "waiting_for_tts_service" && job.tts_wait && job.tts_wait.reason === gate.reason;
  if (same && now.getTime() - Date.parse(job.updated_at) < TTS_WAIT_REFRESH_MS) return;
  const timestamp = now.toISOString();
  job.status = "waiting_for_tts_service";
  job.current_stage = "waiting_for_tts_service";
  job.updated_at = timestamp;
  job.tts_wait = { reason: gate.reason, message: gate.message, since: same ? job.tts_wait.since : timestamp, checked_at: timestamp };
  if (!same) job.history = [...(job.history || []), { at: timestamp, stage: "waiting_for_tts_service", message: gate.message }];
  atomicWriteJson(jobFile, job);
}

function clearTtsWait(jobFile) {
  const job = readJson(jobFile);
  if (!job.tts_wait) return;
  const timestamp = new Date().toISOString();
  delete job.tts_wait;
  job.updated_at = timestamp;
  job.history = [...(job.history || []), { at: timestamp, stage: job.current_stage, message: "Irodoriの起動を確認し音声生成へ進む" }];
  atomicWriteJson(jobFile, job);
}

function pathMappings(config) {
  return [
    { logicalRoot: config.logicalRoot, hostRoot: config.jobsRoot },
    { logicalRoot: config.imageLibraryLogicalRoot, hostRoot: config.imageLibraryRoot },
  ];
}

function resumeStatusForFailure(error) {
  if (!error || typeof error.stage !== "string") return null;
  if (error.stage === "audio_generating") return error.code === "IRODORI_UNAVAILABLE" ? "waiting_for_tts_service" : "audio_generating";
  if (error.stage === "audio_quality_checking") return "audio_ready";
  if (["audio_ready", "subtitle_generating"].includes(error.stage)) return "audio_ready";
  if (error.stage === "image_planning") return "subtitle_ready";
  if (error.stage === "video_generating") return "images_ready";
  if (error.stage === "video_ready") return "video_ready";
  return null;
}

function resetRetryableFailedJob(jobFile, job) {
  if (job.status !== "failed" || !job.error || job.error.retryable !== true) return false;
  const resumeStatus = resumeStatusForFailure(job.error);
  if (!resumeStatus) return false;
  const now = new Date().toISOString();
  job.status = resumeStatus;
  job.current_stage = resumeStatus;
  job.updated_at = now;
  job.error = null;
  job.history = [...(job.history || []), { at: now, stage: resumeStatus, message: `workerが${resumeStatus}から再試行` }];
  atomicWriteJson(jobFile, job);
  return true;
}

async function advanceJob(jobId, config, operations = defaultOperations()) {
  const { directory, jobFile } = safeJobDirectory(config.jobsRoot, jobId);
  const release = acquireJobLock(directory);
  if (!release) return { job_id: jobId, outcome: "busy" };
  let operationStage = null;
  const completed = (result) => { clearWorkerFailures(directory); return result; };

  try {
    let job = readJson(jobFile);
    if (job.version !== 2 || job.mode !== "manual" || job.job_id !== jobId) {
      throw new ManualWorkerError("INVALID_MANUAL_JOB", "version 2手動ジョブだけを処理できます。", { retryable: false });
    }
    const cancellation = applyRequestedCancellation(directory, jobFile);
    if (cancellation) return completed({ job_id: jobId, outcome: "terminal", status: "cancelled" });
    if (TERMINAL_STATES.has(job.status)) return completed({ job_id: jobId, outcome: "terminal", status: job.status });

    const workerState = loadWorkerState(directory);
    if (job.status === "failed") {
      if (!config.retryFailed || workerState.failures >= config.maxRetries || !resetRetryableFailedJob(jobFile, job)) {
        return { job_id: jobId, outcome: "failed", status: job.status, failures: workerState.failures };
      }
      job = readJson(jobFile);
    }

    if (job.status === "queued") {
      operationStage = "segmenting";
      operations.segment(jobId, { root: config.jobsRoot, audioBlockConfig: config.audioBlockConfig });
      return completed({ job_id: jobId, outcome: "advanced", stage: "segments_ready" });
    }

    if (["segments_ready", "waiting_for_tts_service", "audio_generating"].includes(job.status)) {
      const blockMode = hasAudioBlocks(job);
      const pending = blockMode
        ? job.audio_blocks.find((block) => ["pending", "failed", "quality_failed"].includes(block.status))
        : job.segments.find((segment) => segment.audio && ["pending", "failed"].includes(segment.audio.status));
      if (pending) {
        if (config.irodoriAutostart && typeof operations.ensureTts === "function") {
          const gate = await operations.ensureTts(config);
          if (!gate.ready) {
            markTtsWait(jobFile, gate);
            return { job_id: jobId, outcome: "waiting_for_tts", reason: gate.reason };
          }
          clearTtsWait(jobFile);
        }
        operationStage = "audio_generating";
        const operation = blockMode ? operations.generateAudioBlock : operations.generateSegmentAudio;
        await operation(jobId, pending.id, {
          root: config.jobsRoot,
          logicalRoot: config.logicalRoot,
          voiceProfilesPath: config.voiceProfilesPath,
          irodoriUrl: config.irodoriUrl,
          timeoutMs: config.irodoriTimeoutMs,
          pronunciationDictionaryPath: config.pronunciationDictionaryPath,
        });
        return completed({ job_id: jobId, outcome: "advanced", stage: "audio_generation", ...(blockMode ? { audio_block_id: pending.id } : { segment_id: pending.id }) });
      }
      job = readJson(jobFile);
      const allGenerated = hasAudioBlocks(job)
        ? job.audio_blocks.every((block) => block.status === "completed")
        : job.segments.length && job.segments.every((segment) => segment.audio && segment.audio.status === "generated");
      if (allGenerated && job.status !== "audio_ready") {
        job.status = "audio_ready";
        job.current_stage = "audio_ready";
        job.updated_at = new Date().toISOString();
        atomicWriteJson(jobFile, job);
      }
    }

    job = readJson(jobFile);
    if (job.status === "audio_ready" && !job.audio_quality) {
      operationStage = "audio_quality_checking";
      operations.checkAudioQuality(jobId, { root: config.jobsRoot, pronunciationDictionaryPath: config.pronunciationDictionaryPath });
      return completed({ job_id: jobId, outcome: "advanced", stage: "audio_quality_checked" });
    }

    job = readJson(jobFile);
    if (job.status === "audio_ready" && !job.artifacts.audio_file) {
      operationStage = "audio_ready";
      operations.assembleAudio(jobId, {
        root: config.jobsRoot,
        logicalRoot: config.logicalRoot,
        voiceProfilesPath: config.voiceProfilesPath,
        gapSeconds: config.gapSeconds,
        subtitleMinDurationSec: config.subtitleMinDurationSec,
        subtitleMaxDurationSec: config.subtitleMaxDurationSec,
        subtitleGapSec: config.subtitleGapSec,
      });
      return completed({ job_id: jobId, outcome: "advanced", stage: "audio_assembled" });
    }

    job = readJson(jobFile);
    if (job.status === "audio_ready" && job.artifacts.audio_file) {
      operationStage = "subtitle_generating";
      operations.generateSubtitles(jobId, {
        root: config.jobsRoot,
        logicalRoot: config.logicalRoot,
        minCueMs: Math.round(config.subtitleMinDurationSec * 1000),
      });
      return completed({ job_id: jobId, outcome: "advanced", stage: "subtitle_ready" });
    }

    if (job.status === "subtitle_ready") {
      operationStage = "image_planning";
      operations.planImages(jobId, { root: config.jobsRoot });
      return completed({ job_id: jobId, outcome: "advanced", stage: "images_ready" });
    }

    if (job.status === "images_ready") {
      operationStage = "video_generating";
      operations.generateVideo(jobId, {
        root: config.jobsRoot,
        logicalRoot: config.logicalRoot,
        pathMappings: pathMappings(config),
      });
      return completed({ job_id: jobId, outcome: "advanced", stage: "video_ready" });
    }

    if (job.status === "video_ready" && job.archive && ["local_only", "nas_saved"].includes(job.archive.status)) {
      return completed({ job_id: jobId, outcome: "ready", status: job.status, archive_status: job.archive.status });
    }

    if (job.status === "video_ready" && config.localArchiveRoot) {
      operationStage = "video_ready";
      operations.archive(jobId, {
        sourceRoot: config.jobsRoot,
        localArchiveRoot: config.localArchiveRoot,
        localArchiveLogicalRoot: config.localArchiveLogicalRoot,
        nasArchiveRoot: config.nasArchiveRoot || undefined,
        nasArchiveLogicalRoot: config.nasArchiveLogicalRoot,
      });
      return completed({ job_id: jobId, outcome: "advanced", stage: "archived" });
    }

    if (job.status === "video_ready") return completed({ job_id: jobId, outcome: "ready", status: job.status });
    return completed({ job_id: jobId, outcome: "waiting", status: job.status });
  } catch (error) {
    const state = loadWorkerState(directory);
    state.failures += 1;
    const originallyRetryable = error.retryable === true;
    const retryable = originallyRetryable && state.failures < config.maxRetries;
    state.last_error = {
      code: error.code || error.name || "WORKER_ERROR",
      message: publicFailureMessage(error),
      retryable,
      retry_exhausted: originallyRetryable && !retryable,
    };
    state.updated_at = new Date().toISOString();
    saveWorkerState(directory, state);
    markWorkerFailure(jobFile, error, {
      stage: operationStage || failureStage(readJson(jobFile)),
      retryable,
      exhausted: originallyRetryable && !retryable,
    });
    throw error;
  } finally {
    release();
  }
}

function candidateJobs(config) {
  const root = requiredPath(config.jobsRoot, "手動ジョブ保存先");
  const candidates = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
    try {
      const { jobFile } = safeJobDirectory(root, entry.name);
      const job = readJson(jobFile);
      if (TERMINAL_STATES.has(job.status)) continue;
      if (job.status === "video_ready" && job.archive && ["local_only", "nas_saved"].includes(job.archive.status)) continue;
      if (job.status === "failed") {
        const workerState = loadWorkerState(path.dirname(jobFile));
        if (!config.retryFailed || !job.error || job.error.retryable !== true || workerState.failures >= config.maxRetries) continue;
      }
      candidates.push({ id: entry.name, created_at: job.created_at || "", updated_at: job.updated_at || "" });
    } catch {}
  }
  return candidates.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

async function runOne(config, operations) {
  const candidate = candidateJobs(config)[0];
  if (!candidate) {
    const active = operations || defaultOperations();
    if (config.irodoriAutostart && typeof active.stopTts === "function") {
      const result = await active.stopTts(config);
      if (result.stopped) return { outcome: "idle", irodori: "stopped" };
    }
    return { outcome: "idle" };
  }
  return advanceJob(candidate.id, config, operations);
}

function numberEnv(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function configFromEnv(env = process.env) {
  const jobsRoot = requiredPath(env.MANUAL_JOBS_ROOT, "手動ジョブ保存先", true);
  const imageLibraryRoot = requiredPath(env.MANUAL_IMAGE_LIBRARY_ROOT, "画像ライブラリ");
  const logicalRoot = String(env.MANUAL_JOBS_LOGICAL_ROOT || "/data/slideshow/manual_jobs").replace(/\/+$/, "");
  const imageLibraryLogicalRoot = String(env.MANUAL_IMAGE_LIBRARY_LOGICAL_ROOT || "/data/slideshow/images/library").replace(/\/+$/, "");
  return {
    jobsRoot,
    logicalRoot,
    imageLibraryRoot,
    imageLibraryLogicalRoot,
    voiceProfilesPath: requiredPath(env.MANUAL_VOICE_PROFILES_PATH, "音声プロファイル"),
    pronunciationDictionaryPath: requiredPath(env.MANUAL_PRONUNCIATION_DICTIONARY, "手動読み辞書"),
    irodoriUrl: env.MANUAL_IRODORI_URL || "http://127.0.0.1:8088",
    irodoriTimeoutMs: numberEnv(env.MANUAL_IRODORI_TIMEOUT_MS, 600000, 1000),
    irodoriAutostart: autostartEnabled(env),
    gpuCoordinatorUrl: env.MANUAL_GPU_COORDINATOR_URL || "",
    irodoriUnit: env.MANUAL_IRODORI_UNIT || "irodori-tts.service",
    gapSeconds: numberEnv(env.MANUAL_AUDIO_GAP_SECONDS, 0, 0),
    localArchiveRoot: env.MANUAL_LOCAL_ARCHIVE_ROOT ? requiredPath(env.MANUAL_LOCAL_ARCHIVE_ROOT, "local archive保存先", true) : null,
    localArchiveLogicalRoot: env.MANUAL_LOCAL_ARCHIVE_LOGICAL_ROOT || "/local/manual_video_archive",
    nasArchiveRoot: env.MANUAL_NAS_ARCHIVE_ROOT || null,
    nasArchiveLogicalRoot: env.MANUAL_NAS_ARCHIVE_LOGICAL_ROOT || "/data/slideshow/manual_archive",
    retryFailed: env.MANUAL_WORKER_RETRY_FAILED === "1",
    maxRetries: Math.floor(numberEnv(env.MANUAL_WORKER_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0)),
    pollMs: Math.floor(numberEnv(env.MANUAL_WORKER_POLL_MS, DEFAULT_POLL_MS, 1000)),
    audioBlockConfig: audioBlockConfig(env),
    subtitleMinDurationSec: numberEnv(env.SUBTITLE_MIN_DURATION_SEC, 1.2, 0.1),
    subtitleMaxDurationSec: numberEnv(env.SUBTITLE_MAX_DURATION_SEC, 6.0, 0.1),
    subtitleGapSec: numberEnv(env.SUBTITLE_GAP_SEC, 0.05, 0),
  };
}

async function main() {
  const config = configFromEnv();
  const once = process.argv.includes("--once");
  do {
    try {
      const result = await runOne(config);
      process.stdout.write(`${new Date().toISOString()} ${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stderr.write(`${new Date().toISOString()} ${error.code || error.name || "WORKER_ERROR"}: ${error.message}\n`);
    }
    if (!once) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  } while (!once);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });

module.exports = {
  ManualWorkerError,
  advanceJob,
  candidateJobs,
  configFromEnv,
  runOne,
};
