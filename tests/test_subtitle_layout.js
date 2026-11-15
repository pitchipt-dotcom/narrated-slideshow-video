"use strict";

const assert = require("node:assert/strict");
const { layoutTimedSegments, layoutTimedText, splitCues, wrapTwoLines } = require("../backend/subtitle-layout");

const text = "患者さんが安全に立ち上がるため、足の位置を確認します。次に身体を前へ傾け、介助者と一緒にゆっくり立ち上がります。無理はしません。";
const parts = splitCues(text);
assert(parts.length >= 2);
assert.equal(parts.join(""), text);
const cues = layoutTimedText(text, 0, 9000);
assert.equal(cues.map((cue) => cue.text.replace(/\n/gu, "")).join(""), text);
assert(cues.every((cue) => cue.end_ms - cue.start_ms >= 1200));
assert(cues.every((cue) => cue.text.split("\n").length <= 2));
assert(cues.every((cue) => cue.text.split("\n").every((line) => Array.from(line).length <= 20)));
assert.equal(wrapTwoLines("短い字幕です。"), "短い字幕です。");
assert.equal(wrapTwoLines("明示した一行目です。\n明示した二行目です。"), "明示した一行目です。\n明示した二行目です。");
assert.throws(() => layoutTimedText(text, 0, 1000), (error) => error.code === "SUBTITLE_TOO_DENSE");
const reflow = layoutTimedSegments([
  { id: "seg_001", text: "前の字幕です。", start_ms: 0, end_ms: 1800 },
  { id: "seg_002", text: "筋力低下。", start_ms: 1850, end_ms: 2700 },
  { id: "seg_003", text: "後の字幕です。", start_ms: 2700, end_ms: 4200 },
]);
assert(reflow.cues.every((cue) => cue.end_ms - cue.start_ms >= 1200));
assert(reflow.adjustments.some((item) => item.segment_id === "seg_002"));
assert.deepEqual(reflow.cues.map((cue) => cue.text.replace(/\n/gu, "")), ["前の字幕です。", "筋力低下。", "後の字幕です。"]);
console.log("subtitle layout tests: ok");
