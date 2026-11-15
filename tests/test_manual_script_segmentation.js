"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readManualJob, registerManualJob } = require("../backend/manual-job-registration");
const {
  SegmentationError,
  applySegmentationToJob,
  segmentAndSaveManualJob,
  segmentScripts,
} = require("../backend/manual-script-segmentation");

const projectRoot = path.resolve(__dirname, "..");
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("segmentation-dummy-image"),
]);

function register(root, subtitleText, speechText) {
  return registerManualJob({
    title: "台本分割ダミーテスト",
    subtitle_text: subtitleText,
    speech_text: speechText,
  }, [{ name: "dummy.png", type: "image/png", bytes: png }], {
    root,
    now: new Date("2026-07-14T07:40:00.000Z"),
  });
}

const sentenceResult = segmentScripts(
  "正式名称を表示します。次の特徴です！最後の説明です？",
  "せいしきめいしょうを、ひょうじします。つぎの、とくちょうです！さいごの、せつめいです？",
);
assert.equal(sentenceResult.report.segment_count, 3);
assert.equal(sentenceResult.report.subtitle_strategy, "sentence_punctuation");
assert.deepEqual(sentenceResult.segments.map((segment) => segment.id), ["seg_001", "seg_002", "seg_003"]);
assert.equal(sentenceResult.segments[1].subtitle_text, "次の特徴です！");
assert.equal(sentenceResult.segments[1].speech_text, "つぎの、とくちょうです！");

const blockResult = segmentScripts(
  "第一ブロックの1行目\n第一ブロックの2行目\n\n第二ブロック",
  "だいいちぶろっくの、いちぎょうめ\nだいいちぶろっくの、にぎょうめ\n\nだいにぶろっく",
);
assert.equal(blockResult.report.segment_count, 2);
assert.equal(blockResult.report.subtitle_strategy, "blank_line_blocks");
assert.match(blockResult.segments[0].subtitle_text, /\n/);

const explicitSubtitle = "製品名。補足説明。\n===SEGMENT===\n次の項目です。";
const explicitSpeech = "せいひんめいと、ほそくせつめいです\n===SEGMENT===\nつぎの、こうもくです";
const explicitResult = segmentScripts(explicitSubtitle, explicitSpeech);
assert.equal(explicitResult.report.segment_count, 2);
assert.equal(explicitResult.report.explicit_delimiter, "===SEGMENT===");
assert.equal(explicitResult.segments[0].subtitle_text, "製品名。補足説明。");
assert.equal(explicitResult.segments[0].speech_text, "せいひんめいと、ほそくせつめいです");

assert.throws(
  () => segmentScripts("1つ目です。2つ目です。", "ひとつだけです。"),
  (error) => error instanceof SegmentationError
    && error.code === "SEGMENT_COUNT_MISMATCH"
    && error.retryable === false
    && error.details.subtitle_count === 2
    && error.details.speech_count === 1,
);
assert.throws(
  () => segmentScripts("区切り1\n===SEGMENT===\n区切り2", "区切りなし"),
  (error) => error instanceof SegmentationError && error.code === "DELIMITER_MISMATCH",
);

const longResult = segmentScripts("あ".repeat(81), "あ".repeat(81));
assert.equal(longResult.report.warnings[0].code, "LONG_SUBTITLE_SEGMENT");
assert.equal(longResult.report.warnings[0].length, 81);
assert.throws(
  () => segmentScripts("あ".repeat(1001), "あ"),
  (error) => error instanceof SegmentationError && error.code === "SUBTITLE_SEGMENT_TOO_LONG",
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-segmentation-test-"));
try {
  const job = register(root, explicitSubtitle, explicitSpeech);
  const applied = applySegmentationToJob(job, { now: new Date("2026-07-14T07:41:00.000Z") });
  assert.equal(applied.job.input.subtitle_text, explicitSubtitle);
  assert.equal(applied.job.input.speech_text, explicitSpeech);
  assert.equal(applied.job.status, "segments_ready");
  assert.equal(applied.job.segments.length, 2);

  const saved = segmentAndSaveManualJob(job.job_id, {
    root,
    now: new Date("2026-07-14T07:41:00.000Z"),
  });
  assert.equal(saved.job.status, "segments_ready");
  const retrieved = readManualJob(job.job_id, { root });
  assert.deepEqual(retrieved.segments, saved.job.segments);
  assert.equal(retrieved.input.subtitle_text, explicitSubtitle);
  assert.equal(retrieved.input.speech_text, explicitSpeech);
  assert.equal(fs.readdirSync(path.join(root, job.job_id)).some((name) => name.includes(".tmp-")), false);

  const schemaCheck = spawnSync("python3", ["-c", [
    "import json,sys",
    "from jsonschema import Draft202012Validator, FormatChecker",
    "schema=json.load(open(sys.argv[1], encoding='utf-8'))",
    "job=json.load(open(sys.argv[2], encoding='utf-8'))",
    "Draft202012Validator(schema, format_checker=FormatChecker()).validate(job)",
  ].join(";"), path.join(projectRoot, "schemas/manual-video-job.schema.json"), path.join(root, job.job_id, "job.json")], { encoding: "utf8" });
  assert.equal(schemaCheck.status, 0, schemaCheck.stderr);

  const mismatchJob = register(root, "1つ目です。2つ目です。", "ひとつだけです。");
  const mismatchFile = path.join(root, mismatchJob.job_id, "job.json");
  const beforeMismatch = fs.readFileSync(mismatchFile, "utf8");
  assert.throws(
    () => segmentAndSaveManualJob(mismatchJob.job_id, { root }),
    (error) => error instanceof SegmentationError && error.code === "SEGMENT_COUNT_MISMATCH",
  );
  assert.equal(fs.readFileSync(mismatchFile, "utf8"), beforeMismatch);

  console.log("manual script segmentation tests: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
