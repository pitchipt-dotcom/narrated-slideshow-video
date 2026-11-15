"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const JOB_ID_PATTERN = /^job_[A-Za-z0-9_-]{1,120}$/;

class ArtifactArchiveError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = "ArtifactArchiveError"; this.code = code; this.statusCode = statusCode; }
}

function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try { fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o660 }); fs.renameSync(temporary, file); }
  catch (error) { try { fs.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError; } throw error; }
}

function atomicWriteJson(file, value) { atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`); }

function copyTree(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new ArtifactArchiveError("SYMLINK_NOT_ALLOWED", "archiveへシンボリックリンクは含められません。");
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { mode: 0o770 });
    for (const entry of fs.readdirSync(source)) copyTree(path.join(source, entry), path.join(target, entry));
  } else if (stat.isFile()) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

function filesUnder(directory, base = directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new ArtifactArchiveError("SYMLINK_NOT_ALLOWED", "archiveにシンボリックリンクが含まれています。");
    if (entry.isDirectory()) filesUnder(target, base, output);
    else if (entry.isFile() && entry.name !== "manifest.sha256.json") output.push({ file: target, relative: path.relative(base, target).split(path.sep).join("/") });
  }
  return output;
}

function writeManifest(directory, jobId, createdAt) {
  const files = filesUnder(directory).sort((left, right) => left.relative.localeCompare(right.relative));
  const manifest = { version: 1, job_id: jobId, created_at: createdAt, files: files.map(({ file, relative }) => ({ path: relative, bytes: fs.statSync(file).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") })) };
  const target = path.join(directory, "manifest.sha256.json");
  if (fs.existsSync(target)) fs.unlinkSync(target);
  atomicWriteJson(target, manifest);
  return manifest;
}

function prepareBundle(sourceDirectory, job, temporary) {
  for (const name of ["inputs", "metadata"]) fs.mkdirSync(path.join(temporary, name), { recursive: true, mode: 0o770 });
  fs.writeFileSync(path.join(temporary, "inputs", "subtitle_text.txt"), `${job.input.subtitle_text}\n`, { flag: "wx", mode: 0o660 });
  fs.writeFileSync(path.join(temporary, "inputs", "speech_text.txt"), `${job.input.speech_text}\n`, { flag: "wx", mode: 0o660 });
  fs.writeFileSync(path.join(temporary, "metadata", "segments.json"), `${JSON.stringify(job.segments, null, 2)}\n`, { flag: "wx", mode: 0o660 });
  fs.writeFileSync(path.join(temporary, "metadata", "images.json"), `${JSON.stringify(job.images, null, 2)}\n`, { flag: "wx", mode: 0o660 });
  fs.writeFileSync(path.join(temporary, "metadata", "error.json"), `${JSON.stringify(job.error, null, 2)}\n`, { flag: "wx", mode: 0o660 });
  for (const name of ["uploads", "audio", "subtitles", "video"]) copyTree(path.join(sourceDirectory, name), path.join(temporary, name));
  fs.copyFileSync(path.join(sourceDirectory, "job.json"), path.join(temporary, "job.json"), fs.constants.COPYFILE_EXCL);
}

function safeRoot(value, label, create = false) {
  if (!value) throw new ArtifactArchiveError("ROOT_NOT_CONFIGURED", `${label}が設定されていません。`, 503);
  const resolved = path.resolve(value);
  if (create) fs.mkdirSync(resolved, { recursive: true, mode: 0o770 });
  try { return fs.realpathSync(resolved); } catch { throw new ArtifactArchiveError("ROOT_UNAVAILABLE", `${label}を使用できません。`, 503); }
}

function archiveManualArtifacts(jobId, options = {}) {
  if (!JOB_ID_PATTERN.test(String(jobId || ""))) throw new ArtifactArchiveError("INVALID_JOB_ID", "ジョブIDが不正です。");
  const sourceRoot = safeRoot(options.sourceRoot, "手動ジョブ保存先");
  const sourceDirectory = fs.realpathSync(path.join(sourceRoot, jobId));
  if (!sourceDirectory.startsWith(`${sourceRoot}${path.sep}`)) throw new ArtifactArchiveError("UNSAFE_PATH", "手動ジョブルート外はarchiveできません。");
  const jobFile = path.join(sourceDirectory, "job.json");
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  if (job.version !== 2 || job.mode !== "manual" || job.job_id !== jobId || !["video_ready", "completed"].includes(job.status)) throw new ArtifactArchiveError("JOB_NOT_ARCHIVABLE", "完成動画を持つ手動jobだけをarchiveできます。", 409);
  if (!job.artifacts.video_file || !job.output.filename || !fs.existsSync(path.join(sourceDirectory, "video", job.output.filename))) throw new ArtifactArchiveError("VIDEO_NOT_FOUND", "archive対象の完成動画がありません。", 409);
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new ArtifactArchiveError("INVALID_TIME", "保存日時が不正です。");
  const timestamp = now.toISOString();
  const localRoot = safeRoot(options.localArchiveRoot, "local archive保存先", true);
  const localFinal = path.join(localRoot, jobId);
  if (fs.existsSync(localFinal)) throw new ArtifactArchiveError("ARCHIVE_ALREADY_EXISTS", "local archiveはすでに存在します。", 409);
  const localTemporary = fs.mkdtempSync(path.join(localRoot, `.tmp-${jobId}-`));
  let nasFinal = null;
  let nasError = null;
  try {
    prepareBundle(sourceDirectory, job, localTemporary);
    writeManifest(localTemporary, jobId, timestamp);
    fs.renameSync(localTemporary, localFinal);
  } catch (error) { fs.rmSync(localTemporary, { recursive: true, force: true }); throw error; }

  if (options.nasArchiveRoot) {
    try {
      const nasRoot = safeRoot(options.nasArchiveRoot, "NAS archive保存先");
      nasFinal = path.join(nasRoot, jobId);
      if (fs.existsSync(nasFinal)) throw new ArtifactArchiveError("NAS_ARCHIVE_EXISTS", "NAS archiveはすでに存在します。", 409);
      const nasTemporary = fs.mkdtempSync(path.join(nasRoot, `.tmp-${jobId}-`));
      try { for (const entry of fs.readdirSync(localFinal)) copyTree(path.join(localFinal, entry), path.join(nasTemporary, entry)); fs.renameSync(nasTemporary, nasFinal); }
      catch (error) { fs.rmSync(nasTemporary, { recursive: true, force: true }); throw error; }
    } catch (error) { nasFinal = null; nasError = error; }
  }

  const updated = structuredClone(job);
  const nasSaved = Boolean(nasFinal);
  updated.archive = {
    status: nasSaved ? "nas_saved" : "local_only",
    saved_at: timestamp,
    local_archive_path: path.posix.join(String(options.localArchiveLogicalRoot || "/local/manual_video_archive").replace(/\/+$/, ""), jobId),
    nas_archive_path: nasSaved ? path.posix.join(String(options.nasArchiveLogicalRoot || "/data/slideshow/manual_archive").replace(/\/+$/, ""), jobId) : null,
    error: nasError ? "NAS archiveを保存できなかったためlocalに保持しています。" : null,
  };
  if (nasSaved) { updated.status = "completed"; updated.current_stage = "completed"; }
  updated.updated_at = timestamp;
  updated.history.push({ at: timestamp, stage: updated.current_stage, message: nasSaved ? "成果物をlocalとNAS archiveへ保存" : "成果物をlocal archiveへ保存・NASは未保存" });
  atomicWriteJson(jobFile, updated);
  atomicWriteJson(path.join(localFinal, "job.json"), updated);
  const manifest = writeManifest(localFinal, jobId, timestamp);
  if (nasSaved) { atomicWriteJson(path.join(nasFinal, "job.json"), updated); writeManifest(nasFinal, jobId, timestamp); }
  return { job: updated, manifest, local_directory: localFinal, nas_directory: nasFinal, nas_error: nasError ? nasError.code || "NAS_SAVE_FAILED" : null };
}

module.exports = { ArtifactArchiveError, archiveManualArtifacts, writeManifest };
