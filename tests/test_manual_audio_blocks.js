"use strict";
const assert = require("node:assert/strict");
const { attachAudioBlocks, audioBlockConfig, buildAudioBlocks, countReadableCharacters } = require("../backend/manual-audio-blocks");
const { allocateDurations, blockSegmentTimings } = require("../backend/manual-audio-assembly");

const segments = Array.from({ length: 70 }, (_, index) => ({
  id: `seg_${String(index + 1).padStart(3, "0")}`,
  speech_text: `これは第${index + 1}項目を分かりやすく説明する短い文章です。`,
}));
const blocks = attachAudioBlocks(segments, { targetChars: 100, maxChars: 160, minChars: 40, maxSentences: 4 });
assert(blocks.length >= 15 && blocks.length <= 25, `70 subtitles should become 15-25 blocks, got ${blocks.length}`);
assert.equal(blocks.flatMap((block) => block.subtitle_segment_indexes).length, 70);
assert(segments.every((segment) => Number.isInteger(segment.audio_block_index)));
assert(blocks.every((block) => block.sentence_count <= 4));
assert(blocks.slice(0, -1).every((block) => block.readable_characters <= 160));
assert.equal(countReadableCharacters("「歩く。」 空白！"), 4);

const config = audioBlockConfig({
  TTS_BLOCK_TARGET_CHARS: "120", TTS_BLOCK_MAX_CHARS: "180",
  TTS_BLOCK_MIN_CHARS: "50", TTS_BLOCK_MAX_SENTENCES: "3",
});
assert.deepEqual(config, { targetChars: 120, maxChars: 180, minChars: 50, maxSentences: 3 });
assert.throws(() => audioBlockConfig({ TTS_BLOCK_TARGET_CHARS: "200", TTS_BLOCK_MAX_CHARS: "100" }), /min <= target <= max/);

const durations = allocateDurations([10, 20, 30], 9, 1.2, 6);
assert(Math.abs(durations.reduce((sum, value) => sum + value, 0) - 9) < 1e-9);
assert(durations.every((value) => value >= 1.2 && value <= 6));
const timingSegments = [
  { id: "seg_001", speech_text: "短い文。" },
  { id: "seg_002", speech_text: "少し長い説明文です。" },
];
const timings = blockSegmentTimings(
  { id: "block_000", subtitle_segment_indexes: [0, 1] },
  timingSegments, 5, 6, { subtitleMinDurationSec: 1.2, subtitleMaxDurationSec: 6, subtitleGapSec: 0.05 },
);
assert.equal(timings.length, 2);
assert.equal(timings[0].start, 5);
assert(Math.abs(timings[1].start - timings[0].end - 0.05) < 1e-9);
assert(Math.abs(timings.at(-1).end - 11) < 1e-9);

const tooShort = blockSegmentTimings(
  { id: "block_short", subtitle_segment_indexes: [0, 1] },
  timingSegments, 0, 1.5, { subtitleMinDurationSec: 1.2, subtitleMaxDurationSec: 6, subtitleGapSec: 0.05 },
);
assert.equal(tooShort.warning.reason, "gap_removed_and_minimum_relaxed");
assert.equal(tooShort.warning.applied_gap_seconds, 0);
assert(Math.abs(tooShort.at(-1).end - 1.5) < 1e-9);
assert(tooShort.every((timing) => timing.duration > 0));

const tooLong = blockSegmentTimings(
  { id: "block_long", subtitle_segment_indexes: [0, 1] },
  timingSegments, 2, 20, { subtitleMinDurationSec: 1.2, subtitleMaxDurationSec: 6, subtitleGapSec: 0.05 },
);
assert.equal(tooLong.warning.reason, "maximum_relaxed");
assert(tooLong.warning.above_maximum_segment_ids.length > 0);
assert(Math.abs(tooLong.at(-1).end - 22) < 1e-9);

const explicit = buildAudioBlocks([
  { id: "seg_001", speech_text: "読点では、分けません。句点で終わります。" },
  { id: "seg_002", speech_text: "次の意味のまとまりです。" },
], { targetChars: 100, maxChars: 160, minChars: 40, maxSentences: 4 });
assert.equal(explicit.length, 1);
console.log(`manual audio blocks tests: ok (${blocks.length} blocks for 70 subtitles)`);
