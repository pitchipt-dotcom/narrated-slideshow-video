"use strict";

// SRT timestamp: HH:MM:SS,mmm
function formatSrtSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError("seconds must be a non-negative finite number");
  const value = Math.round(seconds * 1000);
  const pad = (number, width = 2) => String(number).padStart(width, "0");
  return `${pad(Math.floor(value / 3600000))}:${pad(Math.floor(value % 3600000 / 60000))}:${pad(Math.floor(value % 60000 / 1000))},${pad(value % 1000, 3)}`;
}

module.exports = { formatSrtSeconds };
