"use strict";

// Runs every tests/test_*.js in its own process and reports a summary.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const files = fs.readdirSync(__dirname).filter((name) => /^test_.*\.js$/.test(name)).sort();
const failed = [];
for (const name of files) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], { encoding: "utf8", timeout: 180000 });
  if (result.status === 0) { process.stdout.write(`ok    ${name}\n`); continue; }
  failed.push(name);
  process.stdout.write(`FAIL  ${name}\n${String(result.stderr || result.stdout || "").split("\n").slice(0, 12).join("\n")}\n`);
}
process.stdout.write(`\n${files.length - failed.length} passed, ${failed.length} failed\n`);
process.exitCode = failed.length ? 1 : 0;
