"use strict";

const DEFAULTS = Object.freeze({
  targetChars: 100,
  maxChars: 160,
  minChars: 40,
  maxSentences: 4,
});

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function audioBlockConfig(source = process.env) {
  const config = {
    targetChars: positiveInteger(source.TTS_BLOCK_TARGET_CHARS, DEFAULTS.targetChars),
    maxChars: positiveInteger(source.TTS_BLOCK_MAX_CHARS, DEFAULTS.maxChars),
    minChars: positiveInteger(source.TTS_BLOCK_MIN_CHARS, DEFAULTS.minChars),
    maxSentences: positiveInteger(source.TTS_BLOCK_MAX_SENTENCES, DEFAULTS.maxSentences),
  };
  if (config.minChars > config.targetChars || config.targetChars > config.maxChars) {
    throw new TypeError("TTS block settings must satisfy min <= target <= max");
  }
  return config;
}

function countReadableCharacters(text) {
  return Array.from(String(text || "").replace(/[\s。、，,.!?！？「」『』（）()[\]【】・:：;；'"…—―-]/gu, "")).length;
}

function sentenceCount(text) {
  return Math.max(1, (String(text || "").match(/[。！？!?]+(?:[」』）)\]】])?/gu) || []).length);
}

function blockId(index) {
  return `block_${String(index).padStart(3, "0")}`;
}

function buildAudioBlocks(segments, options = {}) {
  if (!Array.isArray(segments) || !segments.length) throw new TypeError("segments are required");
  const config = { ...DEFAULTS, ...options };
  if (config.minChars > config.targetChars || config.targetChars > config.maxChars) throw new TypeError("invalid audio block limits");
  const groups = [];
  let current = [];
  let currentChars = 0;
  let currentSentences = 0;
  const flush = () => {
    if (!current.length) return;
    groups.push(current);
    current = []; currentChars = 0; currentSentences = 0;
  };
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const text = String(segment.speech_text || "").trim();
    if (!text) throw new TypeError(`segment ${segment.id || index} has no speech text`);
    const chars = countReadableCharacters(text);
    const sentences = sentenceCount(text);
    const exceeds = current.length && (currentChars + chars > config.maxChars
      || currentSentences + sentences > config.maxSentences);
    if (exceeds) flush();
    current.push({ segment, index });
    currentChars += chars;
    currentSentences += sentences;
    if (currentChars >= config.targetChars || currentSentences >= config.maxSentences) flush();
  }
  flush();
  if (groups.length > 1) {
    const tail = groups.at(-1);
    const previous = groups.at(-2);
    const tailChars = tail.reduce((sum, item) => sum + countReadableCharacters(item.segment.speech_text), 0);
    const combinedChars = [...previous, ...tail].reduce((sum, item) => sum + countReadableCharacters(item.segment.speech_text), 0);
    const combinedSentences = [...previous, ...tail].reduce((sum, item) => sum + sentenceCount(item.segment.speech_text), 0);
    if (tailChars < config.minChars && combinedChars <= config.maxChars && combinedSentences <= config.maxSentences) {
      groups.splice(-2, 2, [...previous, ...tail]);
    }
  }
  return groups.map((items, audioBlockIndex) => {
    const text = items.map((item) => String(item.segment.speech_text).trim()).join("");
    return {
      id: blockId(audioBlockIndex),
      audio_block_index: audioBlockIndex,
      subtitle_segment_indexes: items.map((item) => item.index),
      segment_ids: items.map((item) => item.segment.id),
      text,
      readable_characters: countReadableCharacters(text),
      sentence_count: sentenceCount(text),
      audio_path: null,
      status: "pending",
      duration_seconds: null,
      seed: null,
      started_at: null,
      completed_at: null,
      error: null,
      retry_count: 0,
    };
  });
}

function attachAudioBlocks(segments, options = {}) {
  const audioBlocks = buildAudioBlocks(segments, options);
  for (const block of audioBlocks) {
    for (const index of block.subtitle_segment_indexes) segments[index].audio_block_index = block.audio_block_index;
  }
  return audioBlocks;
}

function hasAudioBlocks(job) {
  return Array.isArray(job && job.audio_blocks) && job.audio_blocks.length > 0;
}

module.exports = {
  DEFAULTS,
  attachAudioBlocks,
  audioBlockConfig,
  blockId,
  buildAudioBlocks,
  countReadableCharacters,
  hasAudioBlocks,
  sentenceCount,
};
