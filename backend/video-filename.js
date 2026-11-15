"use strict";

const DEFAULT_VIDEO_FILENAME = "manual-video.mp4";
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function sanitizeVideoBasename(title, maxCharacters = 100) {
  let value = String(title ?? "").normalize("NFC");
  value = value.replace(/[\0-\x1f\x7f/\\:*?"<>|]/gu, "");
  value = value.replace(/[（(]/gu, " ").replace(/[）)]/gu, "");
  value = value.trim().replace(/^[. ]+|[. ]+$/gu, "");
  value = value.replace(/\s+/gu, "_");
  value = Array.from(value).slice(0, maxCharacters).join("").replace(/[. ]+$/gu, "");
  if (!value) return null;
  if (WINDOWS_RESERVED.test(value)) value = `_${value}`;
  return value;
}

function downloadFilenameForTitle(title) {
  const basename = sanitizeVideoBasename(title);
  if (!basename) return DEFAULT_VIDEO_FILENAME;
  return `${basename}.mp4`;
}

module.exports = { DEFAULT_VIDEO_FILENAME, downloadFilenameForTitle, sanitizeVideoBasename };
