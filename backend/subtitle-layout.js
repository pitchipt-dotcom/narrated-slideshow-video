"use strict";

const MAX_LINE_CHARS = 20;
const MAX_CUE_CHARS = 40;
const MIN_CUE_MS = 1200;
const STRONG = /[。！？!?]/u;
const WEAK = /[、，,；;：:]/u;
const PARTICLES = ["ため", "ので", "から", "まで", "より", "について", "として", "では", "には", "へ", "は", "が", "を", "に", "で", "と", "の", "も"];

class SubtitleLayoutError extends Error {
  constructor(code, message) { super(message); this.name = "SubtitleLayoutError"; this.code = code; }
}

function chars(text) { return Array.from(text); }

function cleanText(text) {
  if (typeof text !== "string" || !text.trim()) throw new SubtitleLayoutError("EMPTY_SUBTITLE", "空の字幕は生成できません。");
  return text.trim().replace(/[ \t\u3000]+/gu, " ").replace(/\s*\n\s*/gu, "\n");
}

function flatText(text) { return cleanText(text); }

function boundaryScore(text, cut) {
  const values = chars(text);
  const before = values[cut - 1] || "";
  if (STRONG.test(before)) return 100;
  if (WEAK.test(before)) return 95;
  if (before === "\n") return 90;
  const prefix = values.slice(0, cut).join("");
  if (PARTICLES.some((particle) => prefix.endsWith(particle))) return 60;
  if (before === " ") return 50;
  return 0;
}

function bestBreak(text, minimum, maximum, target = maximum) {
  const length = chars(text).length;
  const upper = Math.min(maximum, length - 1);
  const lower = Math.max(1, Math.min(minimum, upper));
  let best = null;
  for (let cut = lower; cut <= upper; cut += 1) {
    const score = boundaryScore(text, cut);
    if (!score) continue;
    const rank = score * 100 - Math.abs(cut - target);
    if (!best || rank > best.rank) best = { cut, rank };
  }
  return best ? best.cut : Math.min(Math.max(target, lower), upper);
}

function splitCues(text, maxCueChars = MAX_CUE_CHARS) {
  const remaining = chars(flatText(text));
  const output = [];
  while (remaining.length > maxCueChars) {
    const current = remaining.join("");
    const cut = bestBreak(current, Math.floor(maxCueChars * 0.55), maxCueChars, maxCueChars);
    output.push(remaining.splice(0, cut).join("").trim());
    while (remaining[0] === " ") remaining.shift();
  }
  if (remaining.length) output.push(remaining.join("").trim());
  if (output.some((part) => !part)) throw new SubtitleLayoutError("EMPTY_SUBTITLE", "空の字幕区間が生成されました。");
  return output;
}

function wrapTwoLines(text, maxLineChars = MAX_LINE_CHARS) {
  const cleaned = cleanText(text);
  const explicit = cleaned.split("\n");
  if (explicit.length === 2 && explicit.every((line) => line && chars(line).length <= maxLineChars)) return explicit.join("\n");
  const flattened = cleaned.replace(/\n+/gu, " ");
  const length = chars(flattened).length;
  if (length <= maxLineChars) return flattened;
  if (length > maxLineChars * 2) throw new SubtitleLayoutError("SUBTITLE_LINE_OVERFLOW", "字幕を2行以内に収められません。");
  const minimum = length - maxLineChars;
  const cut = bestBreak(flattened, minimum, maxLineChars, Math.round(length / 2));
  const values = chars(flattened);
  const first = values.slice(0, cut).join("").trim();
  const second = values.slice(cut).join("").trim();
  if (!first || !second || chars(first).length > maxLineChars || chars(second).length > maxLineChars) {
    throw new SubtitleLayoutError("SUBTITLE_LINE_OVERFLOW", "字幕を2行以内に収められません。");
  }
  return `${first}\n${second}`;
}

function allocateTimes(startMs, endMs, texts, minCueMs = MIN_CUE_MS, maxLineChars = MAX_LINE_CHARS) {
  const total = endMs - startMs;
  if (!Number.isFinite(total) || total <= 0) throw new SubtitleLayoutError("INVALID_SUBTITLE_TIME", "字幕時間が不正です。");
  if (total < texts.length * minCueMs) {
    throw new SubtitleLayoutError("SUBTITLE_TOO_DENSE", `字幕${texts.length}区間に最低${minCueMs}msずつ確保できません。`);
  }
  const weights = texts.map((text) => Math.max(1, chars(text.replace(/\s/gu, "")).length));
  const remaining = total - texts.length * minCueMs;
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = startMs;
  let usedExtra = 0;
  return texts.map((text, index) => {
    const extra = index === texts.length - 1 ? remaining - usedExtra : Math.round(remaining * weights[index] / totalWeight);
    usedExtra += extra;
    const end = index === texts.length - 1 ? endMs : cursor + minCueMs + extra;
    const cue = { start_ms: cursor, end_ms: end, text: wrapTwoLines(text, maxLineChars) };
    cursor = end;
    return cue;
  });
}

function layoutTimedText(text, startMs, endMs, options = {}) {
  const parts = splitCues(text, options.maxCueChars || MAX_CUE_CHARS);
  return allocateTimes(startMs, endMs, parts, options.minCueMs || MIN_CUE_MS, options.maxLineChars || MAX_LINE_CHARS);
}

function proportionalTimes(startMs, endMs, texts) {
  const weights = texts.map((text) => Math.max(1, chars(text.replace(/\s/gu, "")).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = startMs;
  let used = 0;
  return texts.map((text, index) => {
    const duration = index === texts.length - 1
      ? endMs - cursor
      : Math.round((endMs - startMs) * weights[index] / totalWeight);
    used += duration;
    const cue = { start_ms: cursor, end_ms: index === texts.length - 1 ? endMs : cursor + duration, text };
    cursor = cue.end_ms;
    return cue;
  });
}

// Layout all segments as one subtitle timeline. Segment audio timing remains the
// desired anchor, while cue boundaries may move across adjacent anchors so every
// displayed cue receives the minimum duration.
function layoutTimedSegments(segments, options = {}) {
  const minCueMs = options.minCueMs || MIN_CUE_MS;
  const maxCueChars = options.maxCueChars || MAX_CUE_CHARS;
  const maxLineChars = options.maxLineChars || MAX_LINE_CHARS;
  if (!Array.isArray(segments) || !segments.length) return { cues: [], adjustments: [] };

  const planned = segments.map((segment) => {
    const texts = splitCues(segment.text, maxCueChars);
    return {
      ...segment,
      texts,
      desired: proportionalTimes(segment.start_ms, segment.end_ms, texts),
    };
  });
  const flat = planned.flatMap((segment) => segment.desired.map((cue) => ({ ...cue, segment_id: segment.id })));
  const timelineStart = planned[0].start_ms;
  const timelineEnd = planned[planned.length - 1].end_ms;
  if (timelineEnd - timelineStart < flat.length * minCueMs) {
    throw new SubtitleLayoutError(
      "SUBTITLE_TOO_DENSE",
      `音声区間${timelineEnd - timelineStart}msに字幕${flat.length}区間（最低${minCueMs}ms）を配置できません。`,
    );
  }

  let previousEnd = timelineStart;
  const cues = flat.map((cue) => {
    const desiredDuration = cue.end_ms - cue.start_ms;
    const duration = Math.max(minCueMs, desiredDuration);
    const centeredStart = desiredDuration < minCueMs
      ? Math.round((cue.start_ms + cue.end_ms - duration) / 2)
      : cue.start_ms;
    const start = Math.max(timelineStart, previousEnd, centeredStart);
    const output = {
      start_ms: start,
      end_ms: start + duration,
      text: wrapTwoLines(cue.text, maxLineChars),
      segment_id: cue.segment_id,
      desired_start_ms: cue.start_ms,
      desired_end_ms: cue.end_ms,
    };
    previousEnd = output.end_ms;
    return output;
  });

  let nextStart = timelineEnd;
  for (let index = cues.length - 1; index >= 0; index -= 1) {
    const cue = cues[index];
    if (cue.end_ms > nextStart) {
      const duration = cue.end_ms - cue.start_ms;
      cue.end_ms = nextStart;
      cue.start_ms = nextStart - duration;
    }
    nextStart = cue.start_ms;
  }
  if (cues[0].start_ms < timelineStart) {
    let cursor = timelineStart;
    for (let index = 0; index < cues.length; index += 1) {
      const remaining = cues.length - index - 1;
      const end = index === cues.length - 1
        ? timelineEnd
        : Math.max(cursor + minCueMs, Math.min(flat[index].end_ms, timelineEnd - remaining * minCueMs));
      cues[index].start_ms = cursor;
      cues[index].end_ms = end;
      cursor = end;
    }
  }
  for (const cue of cues) {
    delete cue.desired_start_ms;
    delete cue.desired_end_ms;
  }

  const adjustments = planned.flatMap((segment) => {
    const after = cues.filter((cue) => cue.segment_id === segment.id);
    const changed = after.length !== segment.desired.length
      || after.some((cue, index) => cue.start_ms !== segment.desired[index].start_ms
        || cue.end_ms !== segment.desired[index].end_ms
        || cue.end_ms - cue.start_ms < minCueMs);
    if (!changed) return [];
    return [{
      segment_id: segment.id,
      before: segment.desired.map((cue) => ({ text: cue.text, start_ms: cue.start_ms, end_ms: cue.end_ms })),
      after: after.map((cue) => ({ text: cue.text, start_ms: cue.start_ms, end_ms: cue.end_ms })),
    }];
  });
  return { cues, adjustments };
}

module.exports = {
  MAX_CUE_CHARS, MAX_LINE_CHARS, MIN_CUE_MS, SubtitleLayoutError, allocateTimes,
  layoutTimedSegments, layoutTimedText, splitCues, wrapTwoLines,
};
