"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { RegistrationError, registerManualJob } = require("./manual-job-registration");
const { ImageLibraryBrowserError, getApprovedAsset, listApprovedAssets, resolveLibrarySelections } = require("./manual-image-library-browser");
const { ImageSettingsError, getManualImageSettings, updateManualImageSettings } = require("./manual-image-settings");
const { JobStatusError, getManualJobStatus, listManualJobStatuses, resolveManualVideo } = require("./manual-job-status");
const { RegenerationError, regenerateManualJob } = require("./manual-job-regeneration");
const { resolveDeliveredVideo } = require("./video-delivery");
const { ImageLibraryReviewError, getReviewImage, listReviewAssets, updateReviewAsset } = require("./image-library-review");
const { DEFAULT_MAX_TOTAL_BYTES, ImageLibraryUploadError, registerUploadedImages } = require("./image-library-upload");
const { CancellationError, requestManualJobCancellation, stopActiveWorker } = require("./manual-job-cancellation");
const {
  PronunciationDictionaryError,
  applyPronunciationDictionary,
  loadPronunciationDictionary,
  savePronunciationDictionary,
} = require("./manual-pronunciation-dictionary");

const MAX_REQUEST_BYTES = 135 * 1024 * 1024;
const FRONTEND_ROOT = path.resolve(__dirname, "../frontend/video-mode-entry");
const STATIC_FILES = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { name: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/image-library-admin", { name: "image-library-admin.html", type: "text/html; charset=utf-8" }],
  ["/image-library-admin.html", { name: "image-library-admin.html", type: "text/html; charset=utf-8" }],
  ["/image-library-admin.js", { name: "image-library-admin.js", type: "text/javascript; charset=utf-8" }],
  ["/image-library-admin.css", { name: "image-library-admin.css", type: "text/css; charset=utf-8" }],
  ["/navigation.css", { name: "navigation.css", type: "text/css; charset=utf-8" }],
  // PWA: manifest, service worker and icons, served from the same origin as the UI.
  ["/manifest.webmanifest", { name: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" }],
  ["/sw.js", { name: "sw.js", type: "text/javascript; charset=utf-8" }],
  ["/icons/icon-192.png", { name: "icons/icon-192.png", type: "image/png" }],
  ["/icons/icon-512.png", { name: "icons/icon-512.png", type: "image/png" }],
]);

class AccessError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "AccessError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function securityHeaders(contentType) {
  const headers = {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), geolocation=(), microphone=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
  if (contentType) headers["content-type"] = contentType;
  return headers;
}

function sendJson(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    ...securityHeaders("application/json; charset=utf-8"),
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function parseAllowedUsers(value) {
  const users = Array.isArray(value) ? value : String(value || "").split(",");
  const normalized = new Set(users.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  if (!normalized.size) throw new AccessError("AUTH_NOT_CONFIGURED", "利用者allowlistが設定されていません。", 503);
  return normalized;
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function authorizeRequest(request, allowedUsers) {
  if (!isLoopback(request.socket.remoteAddress)) throw new AccessError("PROXY_REQUIRED", "安全なプロキシ経由でアクセスしてください。", 403);
  const login = String(request.headers["tailscale-user-login"] || "").trim().toLowerCase();
  if (!login || !allowedUsers.has(login)) throw new AccessError("AUTH_REQUIRED", "許可されたTailscale利用者としてアクセスしてください。", 401);
  return login;
}

function verifyMutationRequest(request, publicOrigin) {
  if (!publicOrigin) throw new AccessError("ORIGIN_NOT_CONFIGURED", "公開Originが設定されていません。", 503);
  if (request.headers.origin !== publicOrigin) throw new AccessError("INVALID_ORIGIN", "送信元を確認できません。", 403);
  if (request.headers["x-requested-with"] !== "manual-video-ui") throw new AccessError("CSRF_CHECK_FAILED", "安全確認ヘッダーがありません。", 403);
}

function sendStatic(response, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const body = fs.readFileSync(path.join(FRONTEND_ROOT, entry.name));
  response.writeHead(200, { ...securityHeaders(entry.type), "content-length": body.length });
  response.end(body);
  return true;
}

function requestUrl(request) {
  return new URL(request.url, `http://${request.headers.host || "localhost"}`);
}

async function serviceAvailable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

function parseByteRange(value, size) {
  if (!value) return null;
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size < 1) return false;
  let start; let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

function sendVideo(request, response, video, download) {
  const stat = fs.statSync(video.file);
  let disposition = `${download ? "attachment" : "inline"}; filename="${video.filename}"`;
  if (download && video.downloadFilename) {
    const asciiFallback = video.downloadFilename.replace(/[^A-Za-z0-9._-]/gu, "_") || "manual-video.mp4";
    const encodedFilename = encodeURIComponent(video.downloadFilename).replace(/['()]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    disposition = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`;
  }
  const range = parseByteRange(request.headers.range, stat.size);
  const common = { ...securityHeaders("video/mp4"), "accept-ranges": "bytes", "content-disposition": disposition, "cache-control": "private, max-age=3600" };
  if (range === false) {
    response.writeHead(416, { ...common, "content-range": `bytes */${stat.size}`, "content-length": 0 }); response.end(); return;
  }
  if (range) {
    response.writeHead(206, { ...common, "content-range": `bytes ${range.start}-${range.end}/${stat.size}`, "content-length": range.length });
    if (request.method === "HEAD") response.end(); else fs.createReadStream(video.file, { start: range.start, end: range.end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...common, "content-length": stat.size });
  if (request.method === "HEAD") response.end(); else fs.createReadStream(video.file).pipe(response);
}

async function parseRegistration(request) {
  const length = Number(request.headers["content-length"] || 0);
  if (length > MAX_REQUEST_BYTES) throw new RegistrationError("REQUEST_TOO_LARGE", "送信サイズが上限を超えています。", 413);
  let received = 0;
  async function* limitedBody() {
    for await (const chunk of request) {
      received += chunk.length;
      if (received > MAX_REQUEST_BYTES) {
        throw new RegistrationError("REQUEST_TOO_LARGE", "送信サイズが上限を超えています。", 413);
      }
      yield chunk;
    }
  }
  const webRequest = new Request("http://localhost/api/manual-video-jobs", {
    method: "POST",
    headers: request.headers,
    body: limitedBody(),
    duplex: "half",
  });
  const form = await webRequest.formData();
  const files = form.getAll("images");
  const images = await Promise.all(files.map(async (file) => ({
    name: file && file.name,
    type: file && file.type,
    bytes: Buffer.from(await file.arrayBuffer()),
  })));
  return {
    input: {
      title: form.get("title"),
      subtitle_text: form.get("subtitle_text"),
      speech_text: form.get("speech_text"),
    },
    images,
    libraryAssetIds: form.getAll("library_asset_ids").map((value) => String(value)),
  };
}

async function parseSmallJson(request) {
  let received = 0;
  const chunks = [];
  for await (const chunk of request) {
    received += chunk.length;
    if (received > 64 * 1024) throw new ImageSettingsError("REQUEST_TOO_LARGE", "画像設定の送信サイズが上限を超えています。", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ImageSettingsError("INVALID_JSON", "JSON形式の画像設定を送信してください。"); }
}

async function parseImageUpload(request) {
  const requestLimit = DEFAULT_MAX_TOTAL_BYTES + 2 * 1024 * 1024;
  const length = Number(request.headers["content-length"] || 0);
  if (length > requestLimit) throw new ImageLibraryUploadError("UPLOAD_TOTAL_TOO_LARGE", "1回の合計容量は100MBまでです。", 413);
  let received = 0;
  async function* limitedBody() {
    for await (const chunk of request) {
      received += chunk.length;
      if (received > requestLimit) throw new ImageLibraryUploadError("UPLOAD_TOTAL_TOO_LARGE", "1回の合計容量は100MBまでです。", 413);
      yield chunk;
    }
  }
  const webRequest = new Request("http://localhost/api/image-library-admin/upload", {
    method: "POST", headers: request.headers, body: limitedBody(), duplex: "half",
  });
  const form = await webRequest.formData();
  const files = form.getAll("images");
  const uploads = await Promise.all(files.map(async (file) => ({
    name: file && file.name, type: file && file.type, bytes: Buffer.from(await file.arrayBuffer()),
  })));
  return {
    uploads,
    fields: {
      note: form.get("note"),
      tags: form.get("tags"),
      rightsConfirmed: form.get("rights_confirmed") === "true",
    },
  };
}

function createManualJobServer(options = {}) {
  const root = options.root || process.env.MANUAL_JOBS_ROOT;
  const logicalRoot = options.logicalRoot || process.env.MANUAL_JOBS_LOGICAL_ROOT;
  const libraryRoot = options.libraryRoot || process.env.MANUAL_IMAGE_LIBRARY_ROOT;
  const libraryLogicalRoot = options.libraryLogicalRoot || process.env.MANUAL_IMAGE_LIBRARY_LOGICAL_ROOT;
  const allowedUsers = parseAllowedUsers(options.allowedUsers || process.env.MANUAL_ALLOWED_TAILSCALE_USERS);
  const publicOrigin = String(options.publicOrigin || process.env.MANUAL_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  const irodoriUrl = String(options.irodoriUrl || process.env.MANUAL_IRODORI_URL || "http://127.0.0.1:8088").replace(/\/+$/, "");
  const pronunciationDictionaryPath = options.pronunciationDictionaryPath || process.env.MANUAL_PRONUNCIATION_DICTIONARY;
  const logError = options.logError || ((record) => process.stderr.write(`${JSON.stringify(record)}\n`));
  if (!root) throw new RegistrationError("ROOT_NOT_CONFIGURED", "MANUAL_JOBS_ROOTを設定してください。", 503);

  return http.createServer(async (request, response) => {
    try {
      const url = requestUrl(request);
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, status: "ok" });
        return;
      }
      authorizeRequest(request, allowedUsers);
      if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) verifyMutationRequest(request, publicOrigin);
      if (request.method === "GET" && sendStatic(response, url.pathname)) return;
      if (request.method === "GET" && url.pathname === "/api/manual-image-library") {
        sendJson(response, 200, { ok: true, ...listApprovedAssets(libraryRoot, { cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") || 12 }) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/manual-pronunciation-dictionary") {
        sendJson(response, 200, { ok: true, dictionary: loadPronunciationDictionary(pronunciationDictionaryPath) });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/manual-pronunciation-dictionary") {
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new PronunciationDictionaryError("UNSUPPORTED_CONTENT_TYPE", "application/jsonで送信してください。", 415);
        const payload = await parseSmallJson(request);
        sendJson(response, 200, { ok: true, dictionary: savePronunciationDictionary(payload.entries, pronunciationDictionaryPath) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/manual-pronunciation-dictionary/test") {
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new PronunciationDictionaryError("UNSUPPORTED_CONTENT_TYPE", "application/jsonで送信してください。", 415);
        const payload = await parseSmallJson(request);
        const text = String(payload.text || "");
        if (!text || text.length > 5000) throw new PronunciationDictionaryError("INVALID_TEST_TEXT", "変換テストは1〜5000文字で入力してください。");
        sendJson(response, 200, { ok: true, result: applyPronunciationDictionary(text, loadPronunciationDictionary(pronunciationDictionaryPath)) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/image-library-admin") {
        sendJson(response, 200, { ok: true, ...listReviewAssets(libraryRoot, { status: url.searchParams.get("status") || "all", sort: url.searchParams.get("sort") || "recent" }) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/image-library-admin/upload") {
        if (!String(request.headers["content-type"] || "").startsWith("multipart/form-data;")) throw new ImageLibraryUploadError("UNSUPPORTED_CONTENT_TYPE", "multipart/form-dataで画像を送信してください。", 415);
        const upload = await parseImageUpload(request);
        sendJson(response, 201, { ok: true, ...registerUploadedImages(libraryRoot, upload.uploads, upload.fields) });
        return;
      }

      const reviewImageMatch = url.pathname.match(/^\/api\/image-library-admin\/([a-z0-9][a-z0-9_-]{7,63})\/thumbnail$/);
      if (request.method === "GET" && reviewImageMatch) {
        const image = getReviewImage(libraryRoot, reviewImageMatch[1]);
        response.writeHead(200, { ...securityHeaders(image.mime), "content-length": image.stat.size, "cache-control": "private, max-age=300" });
        fs.createReadStream(image.file).pipe(response);
        return;
      }

      const reviewAssetMatch = url.pathname.match(/^\/api\/image-library-admin\/([a-z0-9][a-z0-9_-]{7,63})$/);
      if (request.method === "PATCH" && reviewAssetMatch) {
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new ImageLibraryReviewError("UNSUPPORTED_CONTENT_TYPE", "application/jsonで送信してください。", 415);
        const patch = await parseSmallJson(request);
        sendJson(response, 200, { ok: true, item: updateReviewAsset(libraryRoot, reviewAssetMatch[1], patch) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/manual-video-jobs") {
        sendJson(response, 200, { ok: true, ...listManualJobStatuses(root, { cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") || 20 }) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/portal-status") {
        const history = listManualJobStatuses(root, { limit: 50 });
        const latestVideo = history.items.find((item) => item.video_url) || null;
        const irodori = await serviceAvailable(`${irodoriUrl}/health`);
        sendJson(response, 200, {
          ok: true,
          services: { manual_ui: true, irodori },
          latest_manual_video: latestVideo ? {
            title: latestVideo.title,
            updated_at: latestVideo.updated_at,
            video_url: latestVideo.video_url,
          } : null,
        });
        return;
      }

      const thumbnailMatch = url.pathname.match(/^\/api\/manual-image-library\/([a-z0-9][a-z0-9_-]{7,63})\/thumbnail$/);
      if (request.method === "GET" && thumbnailMatch) {
        const asset = getApprovedAsset(libraryRoot, thumbnailMatch[1]);
        const mime = asset.metadata.file.mime_type;
        const stat = fs.statSync(asset.file);
        response.writeHead(200, { ...securityHeaders(mime), "content-length": stat.size, "cache-control": "private, max-age=3600" });
        fs.createReadStream(asset.file).pipe(response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/manual-video-jobs") {
        const contentType = String(request.headers["content-type"] || "");
        if (!contentType.startsWith("multipart/form-data;")) {
          throw new RegistrationError("UNSUPPORTED_CONTENT_TYPE", "multipart/form-dataで送信してください。", 415);
        }
        const payload = await parseRegistration(request);
        const libraryImages = payload.libraryAssetIds.length ? resolveLibrarySelections(libraryRoot, payload.libraryAssetIds, { logicalRoot: libraryLogicalRoot }) : [];
        const job = registerManualJob(payload.input, payload.images, { root, logicalRoot, libraryImages });
        sendJson(response, 201, { ok: true, job_id: job.job_id, status: job.status, mode: job.mode });
        return;
      }

      const settingsMatch = url.pathname.match(/^\/api\/manual-video-jobs\/(job_[A-Za-z0-9_-]{1,120})\/image-settings$/);
      if (request.method === "GET" && settingsMatch) {
        sendJson(response, 200, { ok: true, ...getManualImageSettings(settingsMatch[1], { root }) });
        return;
      }

      const statusMatch = url.pathname.match(/^\/api\/manual-video-jobs\/(job_[A-Za-z0-9_-]{1,120})\/status$/);
      if (request.method === "GET" && statusMatch) {
        sendJson(response, 200, { ok: true, job: getManualJobStatus(root, statusMatch[1]) });
        return;
      }

      const videoMatch = url.pathname.match(/^\/api\/manual-video-jobs\/(job_[A-Za-z0-9_-]{1,120})\/video$/);
      if (["GET", "HEAD"].includes(request.method) && videoMatch) {
        const video = resolveManualVideo(root, videoMatch[1]);
        sendVideo(request, response, video, url.searchParams.get("download") === "true");
        return;
      }

      const deliveredVideoMatch = url.pathname.match(/^\/video\/job\/(job_[A-Za-z0-9_-]{1,120})\/(view|download)$/);
      if (["GET", "HEAD"].includes(request.method) && deliveredVideoMatch) {
        const video = resolveDeliveredVideo({ manualRoot: root }, deliveredVideoMatch[1]);
        sendVideo(request, response, video, deliveredVideoMatch[2] === "download" || url.searchParams.get("download") === "true");
        return;
      }

      const regenerateMatch = url.pathname.match(/^\/api\/manual-video-jobs\/(job_[A-Za-z0-9_-]{1,120})\/regenerate$/);
      if (request.method === "POST" && regenerateMatch) {
        const job = regenerateManualJob(regenerateMatch[1], { root, logicalRoot });
        sendJson(response, 201, { ok: true, job_id: job.job_id, source_job_id: regenerateMatch[1], status: job.status, mode: job.mode });
        return;
      }
      const cancelMatch = url.pathname.match(/^\/api\/manual-video-jobs\/(job_[A-Za-z0-9_-]{1,120})\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        const result = requestManualJobCancellation(cancelMatch[1], { root });
        let processStop = null;
        if (result.pending && result.worker_pid) processStop = await stopActiveWorker(result.worker_pid);
        sendJson(response, result.pending ? 202 : 200, {
          ok: true,
          job_id: cancelMatch[1],
          status: result.pending ? "cancellation_requested" : "cancelled",
          process_stopped: Boolean(processStop && processStop.stopped),
        });
        return;
      }
      if (request.method === "PATCH" && settingsMatch) {
        if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new ImageSettingsError("UNSUPPORTED_CONTENT_TYPE", "application/jsonで送信してください。", 415);
        const payload = await parseSmallJson(request);
        const result = updateManualImageSettings(settingsMatch[1], payload.images, { root });
        sendJson(response, 200, { ok: true, ...result.settings, plan_mode: result.plan_mode });
        return;
      }

      sendJson(response, 404, { ok: false, code: "NOT_FOUND", message: "エンドポイントが見つかりません。" });
    } catch (error) {
      const known = error instanceof AccessError || error instanceof RegistrationError || error instanceof ImageLibraryBrowserError || error instanceof ImageLibraryReviewError || error instanceof ImageLibraryUploadError || error instanceof ImageSettingsError || error instanceof JobStatusError || error instanceof RegenerationError || error instanceof CancellationError || error instanceof PronunciationDictionaryError;
      let pathname = "/";
      try { pathname = requestUrl(request).pathname; } catch {}
      try {
        logError({
          at: new Date().toISOString(), event: "manual_api_error", method: request.method || null, pathname,
          error_name: error.name || "Error", code: known ? error.code : "INTERNAL_ERROR", status_code: known ? error.statusCode : 500,
        });
      } catch {}
      sendJson(response, known ? error.statusCode : 500, {
        ok: false,
        code: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "手動ジョブ登録に失敗しました。",
      });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.MANUAL_JOB_PORT || 8021);
  const server = createManualJobServer();
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`manual job registration listening on 127.0.0.1:${port}\n`);
  });
}

module.exports = { createManualJobServer, parseByteRange };
