"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  applyPronunciationDictionary,
  loadPronunciationDictionary,
  savePronunciationDictionary,
} = require("../backend/manual-pronunciation-dictionary");

(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-dictionary-test-"));
  const file = path.join(root, "dictionary.json");
  try {
    assert.deepEqual(loadPronunciationDictionary(file).entries, []);
    const empty = applyPronunciationDictionary("東京都と京都", { entries: [] });
    assert.equal(empty.text, "東京都と京都");
    savePronunciationDictionary([
      { source: "京都", reading: "きょうと" },
      { source: "東京都", reading: "とうきょうと" },
      { source: "市場", reading: "しじょう" },
    ], file, { now: new Date("2026-07-28T00:00:00.000Z") });
    const converted = applyPronunciationDictionary("東京都の市場と京都の市場", loadPronunciationDictionary(file));
    assert.equal(converted.text, "とうきょうとのしじょうときょうとのしじょう");
    assert.deepEqual(converted.applied.map((entry) => [entry.source, entry.count]), [["東京都", 1], ["京都", 1], ["市場", 2]]);
    assert.throws(() => savePronunciationDictionary([{ source: "市場", reading: "A" }, { source: "市場", reading: "B" }], file), (error) => error.code === "DUPLICATE_DICTIONARY_ENTRY");
    console.log("manual pronunciation dictionary tests: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
