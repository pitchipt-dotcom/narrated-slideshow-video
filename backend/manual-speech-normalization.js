"use strict";

function isDecorativeOnlyLine(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return true;
  if (/^-+$/u.test(trimmed) || /^#+$/u.test(trimmed)) return true;
  const compact = trimmed.replace(/\s+/gu, "");
  if (/^[*_~=]$/u.test(compact)) return true;
  return Array.from(compact).length >= 2 && /^[\p{P}\p{S}]+$/u.test(compact);
}

function normalizeSpeechForIrodori(value) {
  const source = String(value || "");
  const lines = [];
  let removedLineCount = 0;
  let changed = false;

  for (const rawLine of source.split(/\r?\n/u)) {
    let line = rawLine.trim();
    if (!line || isDecorativeOnlyLine(line)) {
      removedLineCount += 1;
      changed = true;
      continue;
    }

    const heading = line.match(/^#{1,6}(?:\s+|$)(.*)$/u);
    if (heading) {
      line = heading[1].replace(/\s+#+\s*$/u, "").trim();
      changed = true;
    }
    if (/^[-*+]\s+/u.test(line)) {
      line = line.replace(/^[-*+]\s+/u, "").trim();
      changed = true;
    }
    if (!line || isDecorativeOnlyLine(line)) {
      removedLineCount += 1;
      changed = true;
      continue;
    }
    lines.push(line);
  }

  const text = lines.join("\n").trim();
  return {
    text,
    intentional_silence: text.length === 0,
    changed: changed || text !== source.trim(),
    removed_line_count: removedLineCount,
  };
}

module.exports = { isDecorativeOnlyLine, normalizeSpeechForIrodori };
