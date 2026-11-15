"use strict";

const assert = require("node:assert/strict");
const { isDecorativeOnlyLine, normalizeSpeechForIrodori } = require("../backend/manual-speech-normalization");

for (const value of ["---", "-", "***", "* * *", "___", "===", "~~~~", "######", "◆◆◆", "……", "   "]) {
  assert.equal(isDecorativeOnlyLine(value), true, value);
  assert.equal(normalizeSpeechForIrodori(value).intentional_silence, true, value);
}

assert.deepEqual(normalizeSpeechForIrodori("### 見出し ###\n\n- 読み上げる項目\n---\n本文中のA-Bとマイナス-5、スーパー、長音ー。"), {
  text: "見出し\n読み上げる項目\n本文中のA-Bとマイナス-5、スーパー、長音ー。",
  intentional_silence: false,
  changed: true,
  removed_line_count: 2,
});
assert.equal(normalizeSpeechForIrodori("ハイフン-を含む文章").text, "ハイフン-を含む文章");
assert.equal(normalizeSpeechForIrodori("ケーキとコーヒー").text, "ケーキとコーヒー");
assert.equal(normalizeSpeechForIrodori("価格は-500円です。").text, "価格は-500円です。");
console.log("manual speech normalization tests: ok");
