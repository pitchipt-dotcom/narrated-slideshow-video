"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { countReadableCharacters, hasAudioBlocks } = require("./manual-audio-blocks");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const LOGICAL_ROOT_DEFAULT = "/data/slideshow/manual_jobs";
const OUTPUT_FILENAME = "assembled.wav";

class AudioAssemblyError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AudioAssemblyError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.cause = options.cause;
  }
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout || 300000,
    });
  } catch (error) {
    throw new AudioAssemblyError("MEDIA_COMMAND_FAILED", `${command}による音声処理に失敗しました。`, { retryable: true, cause: error });
  }
}

function probeDuration(file) {
  const output = run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ], { timeout: 60000 });
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AudioAssemblyError("INVALID_AUDIO_DURATION", "音声の実時間を取得できませんでした。");
  }
  return Math.round(duration * 1e6) / 1e6;
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

function resolveJob(root, jobId) {
  if (!root) throw new AudioAssemblyError("ROOT_NOT_CONFIGURED", "手動ジョブ保存先が設定されていません。");
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new AudioAssemblyError("INVALID_JOB_ID", "ジョブIDが不正です。");
  const realRoot = fs.realpathSync(path.resolve(root));
  const jobDirectory = fs.realpathSync(path.resolve(realRoot, jobId));
  if (!jobDirectory.startsWith(`${realRoot}${path.sep}`)) throw new AudioAssemblyError("UNSAFE_PATH", "手動ジョブルート外のジョブは処理できません。");
  const jobFile = path.join(jobDirectory, "job.json");
  const audioDirectory = fs.realpathSync(path.join(jobDirectory, "audio"));
  if (fs.lstatSync(jobFile).isSymbolicLink() || fs.lstatSync(audioDirectory).isSymbolicLink()) {
    throw new AudioAssemblyError("UNSAFE_PATH", "シンボリックリンクは音声処理に使用できません。");
  }
  return { jobDirectory, jobFile, audioDirectory };
}

function loadTempo(profilePath, profileName) {
  if (!profilePath) throw new AudioAssemblyError("PROFILE_NOT_CONFIGURED", "音声プロファイル設定が指定されていません。");
  const document = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const tempo = Number(document && document.profiles && document.profiles[profileName] && document.profiles[profileName].tempo);
  if (!Number.isFinite(tempo) || tempo < 0.5 || tempo > 2.0) {
    throw new AudioAssemblyError("INVALID_VOICE_TEMPO", "音声プロファイルのtempoを使用できません。");
  }
  return tempo;
}

function validateAndOrderSegments(job, jobId, audioDirectory, logicalRoot) {
  if (!job || job.version !== 2 || job.mode !== "manual" || job.job_id !== jobId) {
    throw new AudioAssemblyError("INVALID_MANUAL_JOB", "version 2の手動ジョブだけを処理できます。");
  }
  if (job.status !== "audio_ready" || job.current_stage !== "audio_ready") {
    throw new AudioAssemblyError("INVALID_JOB_STATE", "全セグメント音声の生成完了後にだけ連結できます。");
  }
  if (!Array.isArray(job.segments) || job.segments.length === 0 || job.segments.length > 100) {
    throw new AudioAssemblyError("INVALID_SEGMENTS", "1〜100件のセグメントが必要です。");
  }
  const ordered = [...job.segments].sort((left, right) => left.order - right.order);
  const ids = new Set();
  const resolved = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const segment = ordered[index];
    if (segment.order !== index + 1 || ids.has(segment.id)) throw new AudioAssemblyError("INVALID_SEGMENT_ORDER", "セグメント順が連続または一意ではありません。");
    ids.add(segment.id);
    if (!segment.audio || segment.audio.status !== "generated") throw new AudioAssemblyError("AUDIO_NOT_READY", `${segment.id}の音声が未生成です。`);
    const expectedLogical = path.posix.join(logicalRoot, jobId, "audio", `${segment.id}.wav`);
    if (segment.audio.path !== expectedLogical) throw new AudioAssemblyError("AUDIO_PATH_MISMATCH", `${segment.id}の音声パスが一致しません。`);
    const source = path.join(audioDirectory, `${segment.id}.wav`);
    if (!fs.existsSync(source) || !fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) {
      throw new AudioAssemblyError("AUDIO_FILE_MISSING", `${segment.id}の音声ファイルがありません。`);
    }
    if (fs.statSync(source).size <= 44) {
      throw new AudioAssemblyError("AUDIO_FILE_EMPTY", `${segment.id}の音声ファイルが空またはWAV headerだけです。`);
    }
    resolved.push({ segment, source_file: source });
  }
  return resolved;
}

function validateAndOrderBlocks(job, jobId, audioDirectory, logicalRoot) {
  if (!Array.isArray(job.audio_blocks) || !job.audio_blocks.length) throw new AudioAssemblyError("INVALID_AUDIO_BLOCKS", "音声ブロックがありません。");
  return [...job.audio_blocks].sort((a, b) => a.audio_block_index - b.audio_block_index).map((block, index) => {
    if (block.audio_block_index !== index || block.status !== "completed") throw new AudioAssemblyError("AUDIO_NOT_READY", `${block.id}の音声が未生成です。`);
    const expectedLogical = path.posix.join(logicalRoot, jobId, "audio", `${block.id}.wav`);
    const source = path.join(audioDirectory, `${block.id}.wav`);
    if (block.audio_path !== expectedLogical || !fs.existsSync(source) || !fs.lstatSync(source).isFile() || fs.statSync(source).size <= 44) {
      throw new AudioAssemblyError("AUDIO_FILE_MISSING", `${block.id}の音声ファイルがありません。`);
    }
    return { block, source_file: source };
  });
}

function allocateDurations(weights, total, minimum, maximum) {
  if (!weights.length || !Number.isFinite(total) || total <= 0 || weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    throw new AudioAssemblyError("INVALID_SUBTITLE_TIMING_INPUT", "字幕時間配分の入力が不正です。");
  }
  // min/maxは可読性の目安。音声実尺を失わないことと文字数比を常に優先する。
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const values = weights.map((weight) => total * weight / weightTotal);
  values[values.length - 1] += total - values.reduce((sum, value) => sum + value, 0);
  return values;
}

function blockSegmentTimings(block, segments, startSeconds, durationSeconds, options = {}) {
  const minimum = Number(options.subtitleMinDurationSec ?? 1.2);
  const maximum = Number(options.subtitleMaxDurationSec ?? 6.0);
  const requestedGap = Number(options.subtitleGapSec ?? 0.05);
  const selected = block.subtitle_segment_indexes.map((index) => segments[index]);
  if (selected.some((segment) => !segment)) throw new AudioAssemblyError("INVALID_AUDIO_BLOCK_MAPPING", `${block.id}の字幕対応が不正です。`);
  const weights = selected.map((segment) => Math.max(1, countReadableCharacters(segment.speech_text)));
  const gapCount = Math.max(0, selected.length - 1);
  const minimumCapacity = minimum * selected.length;
  const gap = durationSeconds - requestedGap * gapCount >= minimumCapacity ? requestedGap : 0;
  const available = durationSeconds - gap * gapCount;
  const durations = allocateDurations(weights, available, minimum, maximum);
  let cursor = startSeconds;
  const timings = selected.map((segment, index) => {
    const start = cursor;
    const end = start + durations[index];
    cursor = end + (index < selected.length - 1 ? gap : 0);
    return { segment, duration: durations[index], start, end };
  });
  const belowMinimum = durations.map((value, index) => ({ value, index })).filter(({ value }) => value < minimum - 1e-6);
  const aboveMaximum = durations.map((value, index) => ({ value, index })).filter(({ value }) => value > maximum + 1e-6);
  if (gap !== requestedGap || belowMinimum.length || aboveMaximum.length) {
    timings.warning = {
      audio_block_id: block.id,
      requested_gap_seconds: requestedGap,
      applied_gap_seconds: gap,
      minimum_duration_seconds: minimum,
      maximum_duration_seconds: maximum,
      below_minimum_segment_ids: belowMinimum.map(({ index }) => selected[index].id),
      above_maximum_segment_ids: aboveMaximum.map(({ index }) => selected[index].id),
      reason: gap !== requestedGap && belowMinimum.length ? "gap_removed_and_minimum_relaxed"
        : (gap !== requestedGap ? "gap_removed" : (belowMinimum.length ? "minimum_relaxed" : "maximum_relaxed")),
    };
  }
  return timings;
}

function timestamp(options) {
  const now = typeof options.now === "function" ? options.now() : (options.now instanceof Date ? options.now : new Date());
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new AudioAssemblyError("INVALID_TIME", "更新日時が不正です。");
  return now.toISOString();
}

function assembleManualAudio(jobId, options = {}) {
  const { jobFile, audioDirectory } = resolveJob(options.root, jobId);
  const logicalRoot = String(options.logicalRoot || LOGICAL_ROOT_DEFAULT).replace(/\/+$/, "");
  const outputLogicalPath = path.posix.join(logicalRoot, jobId, "audio", OUTPUT_FILENAME);
  const outputFile = path.join(audioDirectory, OUTPUT_FILENAME);
  let job = JSON.parse(fs.readFileSync(jobFile, "utf8"));

  if (job.artifacts && job.artifacts.audio_file === outputLogicalPath && fs.existsSync(outputFile)) {
    const completeTimings = Array.isArray(job.segments) && job.segments.every((segment) =>
      Number.isFinite(segment.audio && segment.audio.duration_seconds)
      && Number.isFinite(segment.timing && segment.timing.start_seconds)
      && Number.isFinite(segment.timing && segment.timing.end_seconds));
    if (!completeTimings) throw new AudioAssemblyError("ASSEMBLY_STATE_MISMATCH", "連結音声とセグメント時間の保存状態が一致しません。");
    return { job, output_path: outputLogicalPath, duration_seconds: probeDuration(outputFile), reused: true };
  }
  if (fs.existsSync(outputFile)) throw new AudioAssemblyError("OUTPUT_ALREADY_EXISTS", "未登録の連結音声があるため上書きしません。");

  const blockMode = hasAudioBlocks(job);
  const ordered = blockMode
    ? validateAndOrderBlocks(job, jobId, audioDirectory, logicalRoot)
    : validateAndOrderSegments(job, jobId, audioDirectory, logicalRoot);
  const snapshotTempo = Number(job.voice_generation && job.voice_generation.profile_snapshot && job.voice_generation.profile_snapshot.tempo);
  const tempo = Number.isFinite(snapshotTempo) && snapshotTempo >= 0.5 && snapshotTempo <= 2
    ? snapshotTempo
    : loadTempo(options.voiceProfilesPath, job.voice_profile);
  const gapSeconds = options.gapSeconds === undefined ? 0 : Number(options.gapSeconds);
  if (!Number.isFinite(gapSeconds) || gapSeconds < 0 || gapSeconds > 10) throw new AudioAssemblyError("INVALID_GAP", "セグメント間の無音は0〜10秒で指定してください。");

  const lockFile = path.join(audioDirectory, ".assemble.lock");
  let lock;
  try { lock = fs.openSync(lockFile, "wx", 0o660); } catch (error) {
    if (error.code === "EEXIST") throw new AudioAssemblyError("ASSEMBLY_BUSY", "このジョブの音声連結は実行中です。", { retryable: true });
    throw error;
  }
  const temporaryDirectory = fs.mkdtempSync(path.join(audioDirectory, ".tmp-assembly-"));
  let ownsOutput = false;
  try {
    const processed = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const target = path.join(temporaryDirectory, `segment-${String(index + 1).padStart(3, "0")}.wav`);
      run("ffmpeg", ["-v", "error", "-n", "-i", ordered[index].source_file, "-filter:a", `atempo=${tempo.toFixed(6)}`, "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1", target]);
      processed.push({ file: target, duration: probeDuration(target) });
    }

    let silenceFile = null;
    if (gapSeconds > 0 && processed.length > 1) {
      silenceFile = path.join(temporaryDirectory, "silence.wav");
      run("ffmpeg", ["-v", "error", "-n", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", gapSeconds.toFixed(6), "-c:a", "pcm_s16le", silenceFile]);
    }

    const concatLines = [];
    for (let index = 0; index < processed.length; index += 1) {
      concatLines.push(`file '${path.basename(processed[index].file)}'`);
      if (silenceFile && index < processed.length - 1) concatLines.push(`file '${path.basename(silenceFile)}'`);
    }
    const concatFile = path.join(temporaryDirectory, "inputs.txt");
    fs.writeFileSync(concatFile, `${concatLines.join("\n")}\n`, { encoding: "utf8", flag: "wx", mode: 0o660 });
    const temporaryOutput = path.join(temporaryDirectory, OUTPUT_FILENAME);
    run("ffmpeg", ["-v", "error", "-n", "-f", "concat", "-safe", "1", "-i", path.basename(concatFile), "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1", path.basename(temporaryOutput)], { cwd: temporaryDirectory, timeout: 900000 });

    const outputDuration = probeDuration(temporaryOutput);
    let cursor = 0;
    const timingById = new Map();
    const timingWarnings = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const start = cursor;
      const end = start + processed[index].duration;
      if (blockMode) {
        const blockTimings = blockSegmentTimings(ordered[index].block, job.segments, start, processed[index].duration, options);
        if (blockTimings.warning) {
          timingWarnings.push(blockTimings.warning);
          const warning = { event: "subtitle_timing_constraints_relaxed", job_id: jobId, ...blockTimings.warning };
          if (typeof options.warningLogger === "function") options.warningLogger(warning);
          else process.stderr.write(`${JSON.stringify(warning)}\n`);
        }
        for (const timing of blockTimings) {
          timingById.set(timing.segment.id, {
            duration: Math.round(timing.duration * 1e6) / 1e6,
            start: Math.round(timing.start * 1e6) / 1e6,
            end: Math.round(timing.end * 1e6) / 1e6,
          });
        }
      } else {
        timingById.set(ordered[index].segment.id, {
          duration: Math.round(processed[index].duration * 1e6) / 1e6,
          start: Math.round(start * 1e6) / 1e6,
          end: Math.round(end * 1e6) / 1e6,
        });
      }
      cursor = end + (index < ordered.length - 1 ? gapSeconds : 0);
    }
    if (Math.abs(outputDuration - cursor) > 0.05) {
      throw new AudioAssemblyError("DURATION_MISMATCH", "連結音声と積み上げ時間が一致しません。");
    }

    fs.linkSync(temporaryOutput, outputFile);
    ownsOutput = true;
    job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    if (blockMode) validateAndOrderBlocks(job, jobId, audioDirectory, logicalRoot);
    else validateAndOrderSegments(job, jobId, audioDirectory, logicalRoot);
    if (blockMode) {
      for (let index = 0; index < ordered.length; index += 1) {
        const stored = job.audio_blocks[index];
        stored.duration_seconds = processed[index].duration;
        stored.seed = job.voice_generation.seed;
      }
    }
    for (const segment of job.segments) {
      const timing = timingById.get(segment.id);
      segment.audio.duration_seconds = timing.duration;
      segment.timing = { start_seconds: timing.start, end_seconds: timing.end };
    }
    job.artifacts.audio_file = outputLogicalPath;
    job.updated_at = timestamp(options);
    job.error = null;
    for (const warning of timingWarnings) {
      job.history.push({
        at: job.updated_at,
        stage: "audio_ready",
        message: `${warning.audio_block_id}の字幕時間制約を緩和（${warning.reason}）`,
      });
    }
    job.history.push({ at: job.updated_at, stage: "audio_ready", message: blockMode
      ? `${job.audio_blocks.length}音声ブロックを連結し${job.segments.length}字幕へ時間配分`
      : `${job.segments.length}セグメントの音声時間を保存して連結` });
    atomicWriteJson(jobFile, job);
    return { job, output_path: outputLogicalPath, duration_seconds: outputDuration, tempo, gap_seconds: gapSeconds, timing_warnings: timingWarnings, reused: false };
  } catch (error) {
    if (ownsOutput) {
      try { fs.unlinkSync(outputFile); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; }
    }
    throw error;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    try { fs.closeSync(lock); } finally { try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  }
}

module.exports = {
  AudioAssemblyError,
  LOGICAL_ROOT_DEFAULT,
  OUTPUT_FILENAME,
  assembleManualAudio,
  allocateDurations,
  blockSegmentTimings,
  probeDuration,
};
