"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fixedSeedForProfile } = require("./manual-segment-audio-generation");

const MAX_TITLE_LENGTH = 200;
const MAX_SCRIPT_LENGTH = 20000;
const MAX_IMAGE_COUNT = 20;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 100 * 1024 * 1024;
const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;
const LOGICAL_ROOT_DEFAULT = "/data/slideshow/manual_jobs";

class RegistrationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "RegistrationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function requiredText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw new RegistrationError("INVALID_INPUT", `${label}は必須です。`);
  if (text.length > maxLength) {
    throw new RegistrationError("INVALID_INPUT", `${label}は${maxLength}文字以内で入力してください。`);
  }
  if (/\0/.test(text)) throw new RegistrationError("INVALID_INPUT", `${label}に使用できない文字が含まれています。`);
  return text;
}

function optionalTitle(value) {
  const text = String(value ?? "").trim();
  if (text.length > MAX_TITLE_LENGTH) throw new RegistrationError("INVALID_INPUT", `動画タイトルは${MAX_TITLE_LENGTH}文字以内で入力してください。`);
  if (/\0/.test(text)) throw new RegistrationError("INVALID_INPUT", "動画タイトルに使用できない文字が含まれています。");
  return text;
}

function safeOriginalFilename(value) {
  const name = String(value ?? "").normalize("NFC").trim();
  if (!name || name.length > 255 || /[\0-\x1f\x7f]/.test(name)) {
    throw new RegistrationError("INVALID_FILENAME", "画像ファイル名が不正です。");
  }
  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new RegistrationError("INVALID_FILENAME", "画像ファイル名にパスを含めることはできません。");
  }
  return name;
}

function detectImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", extension: "png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", extension: "webp" };
  }
  throw new RegistrationError("INVALID_IMAGE", "JPEG・PNG・WebPとして確認できない画像があります。");
}

function normalizeImages(images) {
  if (!Array.isArray(images) || images.length > MAX_IMAGE_COUNT) {
    throw new RegistrationError("INVALID_IMAGE_COUNT", `アップロード画像は${MAX_IMAGE_COUNT}枚以内にしてください。`);
  }
  let totalBytes = 0;
  return images.map((image, index) => {
    const originalFilename = safeOriginalFilename(image && image.name);
    const bytes = Buffer.isBuffer(image && image.bytes) ? image.bytes : Buffer.from(image && image.bytes ? image.bytes : []);
    if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) {
      throw new RegistrationError("INVALID_IMAGE_SIZE", `${originalFilename}は1バイト以上20MB以下にしてください。`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new RegistrationError("TOTAL_IMAGE_SIZE_EXCEEDED", "画像の合計サイズは100MB以下にしてください。");
    }
    const detected = detectImage(bytes);
    const declaredType = String(image.type || "").toLowerCase();
    if (declaredType && declaredType !== detected.mime) {
      throw new RegistrationError("IMAGE_TYPE_MISMATCH", `${originalFilename}の申告形式と内容が一致しません。`);
    }
    const number = String(index + 1).padStart(3, "0");
    return {
      id: `image_${number}`,
      originalFilename,
      storedFilename: `image_${number}.${detected.extension}`,
      mime: detected.mime,
      bytes,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

function normalizeLibraryImages(images) {
  if (!Array.isArray(images) || images.length > MAX_IMAGE_COUNT) throw new RegistrationError("INVALID_IMAGE_COUNT", `ライブラリ画像は${MAX_IMAGE_COUNT}枚以内にしてください。`);
  return images.map((image) => {
    if (!image || !/^[a-z0-9][a-z0-9_-]{7,63}$/.test(String(image.assetId || ""))
      || !/^[a-f0-9]{64}$/.test(String(image.sha256 || "")) || typeof image.storedPath !== "string" || !image.storedPath.startsWith("/")) {
      throw new RegistrationError("INVALID_LIBRARY_IMAGE", "ライブラリ画像の参照が不正です。");
    }
    return {
      assetId: image.assetId,
      originalFilename: safeOriginalFilename(image.originalFilename),
      storedFilename: safeOriginalFilename(image.storedFilename),
      storedPath: image.storedPath,
      sha256: image.sha256,
    };
  });
}

function resolveRoot(root) {
  if (!root) throw new RegistrationError("ROOT_NOT_CONFIGURED", "手動ジョブ保存先が設定されていません。", 503);
  const resolved = path.resolve(root);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o770 });
  return fs.realpathSync(resolved);
}

function containedPath(root, ...parts) {
  const candidate = path.resolve(root, ...parts);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new RegistrationError("UNSAFE_PATH", "許可された保存先の外へは書き込めません。", 400);
  }
  return candidate;
}

function createJobDirectory(root, now) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const jobId = `job_${stamp}_${crypto.randomBytes(6).toString("hex")}`;
    const directory = containedPath(root, jobId);
    try {
      fs.mkdirSync(directory, { mode: 0o770 });
      return { jobId, directory };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new RegistrationError("JOB_ID_COLLISION", "一意なジョブIDを作成できませんでした。", 503);
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o660 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
    throw error;
  }
}

function buildJob(input, normalizedImages, normalizedLibraryImages, jobId, now, logicalRoot) {
  const timestamp = now.toISOString();
  return {
    version: 2,
    mode: "manual",
    job_id: jobId,
    status: "queued",
    current_stage: "queued",
    created_at: timestamp,
    updated_at: timestamp,
    input: {
      title: optionalTitle(input.title),
      subtitle_text: requiredText(input.subtitle_text, "字幕表示用台本", MAX_SCRIPT_LENGTH),
      speech_text: requiredText(input.speech_text, "読み上げ用台本", MAX_SCRIPT_LENGTH),
      request_note: "",
    },
    segments: [],
    images: [
      ...normalizedImages.map((image, index) => ({
      id: image.id,
      source: "upload",
      order: index + 1,
      segment_ids: [],
      requested_duration_seconds: null,
      original_filename: image.originalFilename,
      stored_filename: image.storedFilename,
      stored_path: path.posix.join(logicalRoot, jobId, "uploads", image.storedFilename),
      sha256: image.sha256,
      start_seconds: null,
      end_seconds: null,
      duration_seconds: null,
      library_asset_id: null,
      })),
      ...normalizedLibraryImages.map((image, index) => ({
        id: `image_${String(normalizedImages.length + index + 1).padStart(3, "0")}`,
        source: "library",
        order: normalizedImages.length + index + 1,
        segment_ids: [],
        requested_duration_seconds: null,
        original_filename: image.originalFilename,
        stored_filename: image.storedFilename,
        stored_path: image.storedPath,
        sha256: image.sha256,
        start_seconds: null,
        end_seconds: null,
        duration_seconds: null,
        library_asset_id: image.assetId,
      })),
    ],
    output: { filename: null, aspect_ratio: "3:2", subtitle_size: 42, subtitle_position: "bottom" },
    artifacts: { audio_file: null, subtitle_file: null, video_file: null },
    voice_profile: "calm_female_06",
    voice_generation: {
      version: 1,
      seed: fixedSeedForProfile("calm_female_06"),
      profile: "calm_female_06",
      conditioning_mode: null,
      reference_audio_used: false,
      profile_fingerprint: null,
      profile_snapshot: null,
    },
    attempts: 0,
    history: [{ at: timestamp, stage: "queued", message: "手動入力を登録" }],
    review: { required: false, reasons: [] },
    error: null,
  };
}

function registerManualJob(input, images, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new RegistrationError("INVALID_TIME", "登録日時が不正です。");
  const root = resolveRoot(options.root);
  const logicalRoot = String(options.logicalRoot || LOGICAL_ROOT_DEFAULT).replace(/\/+$/, "");
  if (!logicalRoot.startsWith("/") || logicalRoot.includes("..")) {
    throw new RegistrationError("UNSAFE_LOGICAL_ROOT", "論理保存先が不正です。");
  }
  const normalizedImages = normalizeImages(images);
  const normalizedLibraryImages = normalizeLibraryImages(options.libraryImages || []);
  if (normalizedImages.length + normalizedLibraryImages.length < 1 || normalizedImages.length + normalizedLibraryImages.length > MAX_IMAGE_COUNT) {
    throw new RegistrationError("INVALID_IMAGE_COUNT", `アップロード画像とライブラリ画像の合計は1〜${MAX_IMAGE_COUNT}枚にしてください。`);
  }
  const { jobId, directory } = createJobDirectory(root, now);
  try {
    const uploads = containedPath(root, jobId, "uploads");
    fs.mkdirSync(uploads, { mode: 0o770 });
    for (const name of ["audio", "subtitles", "video"]) fs.mkdirSync(containedPath(root, jobId, name), { mode: 0o770 });
    for (const image of normalizedImages) {
      fs.writeFileSync(containedPath(root, jobId, "uploads", image.storedFilename), image.bytes, { flag: "wx", mode: 0o660 });
    }
    const job = buildJob(input, normalizedImages, normalizedLibraryImages, jobId, now, logicalRoot);
    atomicWriteJson(containedPath(root, jobId, "job.json"), job);
    return job;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function readManualJob(jobId, options = {}) {
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) {
    throw new RegistrationError("INVALID_JOB_ID", "ジョブIDが不正です。");
  }
  const root = resolveRoot(options.root);
  const file = containedPath(root, jobId, "job.json");
  try {
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    if (job.job_id !== jobId || job.version !== 2 || job.mode !== "manual") {
      throw new RegistrationError("INVALID_SAVED_JOB", "保存された手動ジョブを確認できません。", 500);
    }
    return job;
  } catch (error) {
    if (error.code === "ENOENT") throw new RegistrationError("JOB_NOT_FOUND", "手動ジョブが見つかりません。", 404);
    throw error;
  }
}

module.exports = {
  LOGICAL_ROOT_DEFAULT,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_IMAGE_BYTES,
  RegistrationError,
  readManualJob,
  registerManualJob,
};
