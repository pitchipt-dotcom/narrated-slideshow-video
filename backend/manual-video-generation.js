"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { probeDuration } = require("./manual-audio-assembly");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.mp4$/;
const DIMENSIONS = { "3:2": [768, 512], "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [720, 720] };
const IMAGE_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const OUTPUT_FPS = 30;
const OUTPUT_DURATION_TOLERANCE_SECONDS = 0.1;

class VideoGenerationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "VideoGenerationError";
    this.code = code;
    this.retryable = options.retryable !== false;
    this.cause = options.cause;
  }
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: options.timeout || 900000 });
  } catch (error) {
    throw new VideoGenerationError("MEDIA_COMMAND_FAILED", `${command}による動画処理に失敗しました。`, { cause: error });
  }
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

function timestamp(options) {
  const now = typeof options.now === "function" ? options.now() : (options.now instanceof Date ? options.now : new Date());
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new VideoGenerationError("INVALID_TIME", "更新日時が不正です。", { retryable: false });
  return now.toISOString();
}

function resolveJob(root, jobId) {
  if (!root) throw new VideoGenerationError("ROOT_NOT_CONFIGURED", "手動ジョブ保存先が設定されていません。", { retryable: false });
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new VideoGenerationError("INVALID_JOB_ID", "ジョブIDが不正です。", { retryable: false });
  const realRoot = fs.realpathSync(path.resolve(root));
  const directory = fs.realpathSync(path.join(realRoot, jobId));
  if (!directory.startsWith(`${realRoot}${path.sep}`)) throw new VideoGenerationError("UNSAFE_PATH", "手動ジョブルート外は処理できません。", { retryable: false });
  const jobFile = path.join(directory, "job.json");
  const videoDirectory = fs.realpathSync(path.join(directory, "video"));
  if (fs.lstatSync(jobFile).isSymbolicLink() || fs.lstatSync(videoDirectory).isSymbolicLink()) throw new VideoGenerationError("UNSAFE_PATH", "シンボリックリンクは動画生成に使用できません。", { retryable: false });
  return { jobFile, videoDirectory };
}

function resolveLogicalFile(logicalValue, mappings, suffixes) {
  if (typeof logicalValue !== "string" || !logicalValue.startsWith("/") || logicalValue.split("/").includes("..")) throw new VideoGenerationError("UNSAFE_LOGICAL_PATH", "入力論理パスが不正です。", { retryable: false });
  const sorted = [...(mappings || [])].sort((left, right) => String(right.logicalRoot).length - String(left.logicalRoot).length);
  for (const mapping of sorted) {
    const logicalRoot = String(mapping.logicalRoot || "").replace(/\/+$/, "");
    if (logicalValue !== logicalRoot && !logicalValue.startsWith(`${logicalRoot}/`)) continue;
    const hostRoot = fs.realpathSync(path.resolve(mapping.hostRoot));
    const relative = logicalValue.slice(logicalRoot.length).replace(/^\/+/, "");
    const candidate = fs.realpathSync(path.join(hostRoot, ...relative.split("/")));
    if (candidate !== hostRoot && !candidate.startsWith(`${hostRoot}${path.sep}`)) throw new VideoGenerationError("UNSAFE_PATH", "入力ファイルが許可ルート外です。", { retryable: false });
    if (!fs.lstatSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink() || !suffixes.has(path.extname(candidate).toLowerCase())) throw new VideoGenerationError("INVALID_INPUT_FILE", "入力ファイル形式が不正です。", { retryable: false });
    return candidate;
  }
  throw new VideoGenerationError("PATH_MAPPING_NOT_FOUND", "入力論理パスの対応先がありません。", { retryable: false });
}

function probeMedia(file) {
  const raw = run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,duration", "-of", "json", file], { timeout: 60000 });
  const report = JSON.parse(raw);
  const video = report.streams.find((stream) => stream.codec_type === "video");
  const audio = report.streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(report.format && report.format.duration);
  const videoDuration = Number(video && video.duration);
  const audioDuration = Number(audio && audio.duration);
  const frameRateParts = String(video && video.avg_frame_rate || "").split("/").map(Number);
  const fps = frameRateParts.length === 2 && Number.isFinite(frameRateParts[0]) && Number.isFinite(frameRateParts[1]) && frameRateParts[1] !== 0
    ? frameRateParts[0] / frameRateParts[1]
    : NaN;
  if (!video || !audio || !Number.isFinite(duration) || !Number.isFinite(videoDuration)
    || !Number.isFinite(audioDuration) || !Number.isFinite(fps)) {
    throw new VideoGenerationError("INVALID_VIDEO_OUTPUT", "生成動画のcodec、fps、またはstream時間を確認できません。");
  }
  return {
    duration_seconds: duration,
    video_duration_seconds: videoDuration,
    audio_duration_seconds: audioDuration,
    video_codec: video.codec_name,
    audio_codec: audio.codec_name,
    width: video.width,
    height: video.height,
    fps,
    pix_fmt: video.pix_fmt,
  };
}

function mediaMismatches(media, expected) {
  const mismatches = [];
  if (media.video_codec !== "h264") mismatches.push(`video codec expected=h264 actual=${media.video_codec}`);
  if (media.audio_codec !== "aac") mismatches.push(`audio codec expected=aac actual=${media.audio_codec}`);
  if (media.width !== expected.width) mismatches.push(`width expected=${expected.width} actual=${media.width}`);
  if (media.height !== expected.height) mismatches.push(`height expected=${expected.height} actual=${media.height}`);
  if (Math.abs(media.fps - OUTPUT_FPS) > 0.001) mismatches.push(`fps expected=${OUTPUT_FPS} actual=${media.fps}`);
  if (media.pix_fmt !== "yuv420p") mismatches.push(`pix_fmt expected=yuv420p actual=${media.pix_fmt}`);
  for (const [label, actual] of [
    ["container duration", media.duration_seconds],
    ["video duration", media.video_duration_seconds],
    ["audio duration", media.audio_duration_seconds],
  ]) {
    const difference = Math.abs(actual - expected.duration_seconds);
    if (difference > OUTPUT_DURATION_TOLERANCE_SECONDS) {
      mismatches.push(`${label} expected=${expected.duration_seconds.toFixed(6)} actual=${actual.toFixed(6)} diff=${difference.toFixed(6)} tolerance=${OUTPUT_DURATION_TOLERANCE_SECONDS.toFixed(3)}`);
    }
  }
  return mismatches;
}

function validateJob(job, jobId, options) {
  if (!job || job.version !== 2 || job.mode !== "manual" || job.job_id !== jobId) throw new VideoGenerationError("INVALID_MANUAL_JOB", "version 2手動ジョブだけを処理できます。、", { retryable: false });
  if (job.status !== "images_ready" || job.current_stage !== "images_ready") throw new VideoGenerationError("INVALID_JOB_STATE", "画像計画完了後にだけ動画を生成できます。", { retryable: false });
  const dimensions = DIMENSIONS[job.output && job.output.aspect_ratio];
  if (!dimensions) throw new VideoGenerationError("INVALID_ASPECT_RATIO", "出力縦横比が不正です。", { retryable: false });
  const ordered = [...job.images].sort((left, right) => left.order - right.order);
  if (!ordered.length || ordered.length > 100) throw new VideoGenerationError("INVALID_IMAGE_COUNT", "画像は1〜100件必要です。", { retryable: false });
  let cursor = 0;
  const images = ordered.map((image, index) => {
    const start = Number(image.start_seconds); const end = Number(image.end_seconds); const duration = Number(image.duration_seconds);
    if (image.order !== index + 1 || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(duration)
      || Math.abs(start - cursor) > 0.01 || end <= start || Math.abs(duration - (end - start)) > 0.01) throw new VideoGenerationError("INVALID_IMAGE_TIMELINE", "画像順または表示時間が不正です。", { retryable: false });
    cursor = end;
    return { file: resolveLogicalFile(image.stored_path, options.pathMappings, IMAGE_SUFFIXES), duration };
  });
  const audio = resolveLogicalFile(job.artifacts.audio_file, options.pathMappings, new Set([".wav"]));
  const subtitle = resolveLogicalFile(job.artifacts.subtitle_file, options.pathMappings, new Set([".srt"]));
  const audioDuration = probeDuration(audio);
  if (Math.abs(cursor - audioDuration) > 0.05) throw new VideoGenerationError("TIMELINE_AUDIO_MISMATCH", "画像表示時間と音声時間が一致しません。", { retryable: false });
  return { images, audio, subtitle, audioDuration, dimensions };
}

function generateManualVideo(jobId, options = {}) {
  const { jobFile, videoDirectory } = resolveJob(options.root, jobId);
  const logicalRoot = String(options.logicalRoot || "/data/slideshow/manual_jobs").replace(/\/+$/, "");
  let job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const filename = job.output && job.output.filename ? job.output.filename : "manual-video.mp4";
  if (!OUTPUT_NAME_PATTERN.test(filename) || path.basename(filename) !== filename) throw new VideoGenerationError("INVALID_OUTPUT_NAME", "安全なMP4ファイル名を指定してください。", { retryable: false });
  const outputFile = path.join(videoDirectory, filename);
  const outputLogicalPath = path.posix.join(logicalRoot, jobId, "video", filename);
  if (job.artifacts && job.artifacts.video_file === outputLogicalPath && fs.existsSync(outputFile)) return { job, output_path: outputLogicalPath, media: probeMedia(outputFile), reused: true };
  if (fs.existsSync(outputFile)) throw new VideoGenerationError("OUTPUT_ALREADY_EXISTS", "未登録の同名動画があるため上書きしません。", { retryable: false });
  const inputs = validateJob(job, jobId, options);
  const lockFile = path.join(videoDirectory, ".video.lock");
  let lock;
  try { lock = fs.openSync(lockFile, "wx", 0o660); } catch (error) {
    if (error.code === "EEXIST") throw new VideoGenerationError("VIDEO_BUSY", "このジョブの動画生成は実行中です。", { retryable: true });
    throw error;
  }
  const temporaryDirectory = fs.mkdtempSync(path.join(videoDirectory, ".tmp-video-"));
  let ownsOutput = false;
  let startedAt = null;
  try {
    startedAt = timestamp(options);
    job.status = "video_generating"; job.current_stage = "video_generating"; job.updated_at = startedAt; job.error = null; job.attempts = Number(job.attempts || 0) + 1;
    job.history.push({ at: startedAt, stage: "video_generating", message: `${inputs.images.length}画像から動画生成開始` });
    atomicWriteJson(jobFile, job);

    const [width, height] = inputs.dimensions;
    const normalizeFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    const localImages = inputs.images.map((image, index) => {
      const number = String(index + 1).padStart(3, "0");
      const copied = path.join(temporaryDirectory, `source-${number}${path.extname(image.file).toLowerCase()}`);
      const normalized = path.join(temporaryDirectory, `image-${number}.png`);
      fs.copyFileSync(image.file, copied, fs.constants.COPYFILE_EXCL);
      run("ffmpeg", ["-v", "error", "-n", "-i", path.basename(copied), "-vf", normalizeFilter, "-frames:v", "1", path.basename(normalized)], { cwd: temporaryDirectory, timeout: 60000 });
      return { file: normalized, duration: image.duration };
    });
    const localAudio = path.join(temporaryDirectory, "audio.wav");
    const localSubtitle = path.join(temporaryDirectory, "subtitle.srt");
    fs.copyFileSync(inputs.audio, localAudio, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(inputs.subtitle, localSubtitle, fs.constants.COPYFILE_EXCL);
    let imageInput;
    if (localImages.length === 1) {
      imageInput = ["-loop", "1", "-i", path.basename(localImages[0].file)];
    } else {
      const lines = [];
      for (const image of localImages) lines.push(`file '${path.basename(image.file)}'`, `duration ${image.duration.toFixed(6)}`);
      lines.push(`file '${path.basename(localImages.at(-1).file)}'`);
      fs.writeFileSync(path.join(temporaryDirectory, "images.txt"), `${lines.join("\n")}\n`, { flag: "wx", mode: 0o660 });
      imageInput = ["-f", "concat", "-safe", "1", "-i", "images.txt"];
    }
    const temporaryOutput = path.join(temporaryDirectory, filename);
    const targetDuration = inputs.audioDuration.toFixed(6);
    const subtitleStyle = "FontName=Noto Sans CJK JP,FontSize=30,Outline=2,Shadow=0,Alignment=2,MarginL=54,MarginR=54,MarginV=38,WrapStyle=2";
    const filter = `setsar=1,fps=${OUTPUT_FPS},tpad=stop_mode=clone:stop_duration=${targetDuration},trim=duration=${targetDuration},setpts=PTS-STARTPTS,subtitles=subtitle.srt:force_style='${subtitleStyle}'`;
    const audioFilter = `atrim=duration=${targetDuration},asetpts=PTS-STARTPTS`;
    run("ffmpeg", ["-v", "error", "-n", ...imageInput, "-i", "audio.wav", "-vf", filter,
      "-af", audioFilter,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-tune", "stillimage",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", filename], { cwd: temporaryDirectory, timeout: 900000 });
    const media = probeMedia(temporaryOutput);
    const mismatches = mediaMismatches(media, { width, height, duration_seconds: inputs.audioDuration });
    if (mismatches.length) {
      throw new VideoGenerationError("VIDEO_OUTPUT_MISMATCH", `動画検証不一致: ${mismatches.join("; ")}`, { retryable: false });
    }
    fs.linkSync(temporaryOutput, outputFile); ownsOutput = true;
    job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    if (job.updated_at !== startedAt || job.status !== "video_generating") throw new VideoGenerationError("JOB_CHANGED", "動画生成中にジョブ状態が変更されました。", { retryable: true });
    const completedAt = timestamp(options);
    job.status = "video_ready"; job.current_stage = "video_ready"; job.updated_at = completedAt; job.output.filename = filename; job.artifacts.video_file = outputLogicalPath; job.error = null;
    job.history.push({ at: completedAt, stage: "video_ready", message: "H.264/AAC動画を保存" });
    atomicWriteJson(jobFile, job);
    return { job, output_path: outputLogicalPath, media, reused: false };
  } catch (error) {
    if (ownsOutput) { try { fs.unlinkSync(outputFile); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; } }
    if (startedAt) {
      try {
        const failed = JSON.parse(fs.readFileSync(jobFile, "utf8"));
        if (failed.updated_at === startedAt && failed.status === "video_generating") {
          const failedAt = timestamp(options);
          failed.status = "failed"; failed.current_stage = "failed"; failed.updated_at = failedAt;
          failed.error = { stage: "video_generating", code: error.code || "VIDEO_GENERATION_FAILED", message: error.message || "動画生成に失敗しました。", retryable: error.retryable !== false, segment_id: null };
          failed.history.push({ at: failedAt, stage: "failed", message: "FFmpeg動画生成に失敗" });
          atomicWriteJson(jobFile, failed);
        }
      } catch (stateError) { error.stateError = stateError; }
    }
    throw error;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    try { fs.closeSync(lock); } finally { try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  }
}

module.exports = { VideoGenerationError, generateManualVideo, mediaMismatches, probeMedia, resolveLogicalFile };
