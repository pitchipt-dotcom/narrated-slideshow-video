"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_ENTRIES = 500;
const MAX_TERM_CHARS = 100;
class PronunciationDictionaryError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.name = "PronunciationDictionaryError"; this.code = code; this.statusCode = statusCode; }
}

function dictionaryPath(value) {
  const configured = value || process.env.MANUAL_PRONUNCIATION_DICTIONARY;
  if (!configured) throw new PronunciationDictionaryError("DICTIONARY_NOT_CONFIGURED", "MANUAL_PRONUNCIATION_DICTIONARYを設定してください。", 503);
  return path.resolve(configured);
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new PronunciationDictionaryError("INVALID_DICTIONARY", `読み辞書は${MAX_ENTRIES}件以内で指定してください。`);
  const seen = new Set();
  return entries.map((entry, index) => {
    const source = String(entry && entry.source || "").trim();
    const reading = String(entry && entry.reading || "").trim();
    if (!source || !reading || Array.from(source).length > MAX_TERM_CHARS || Array.from(reading).length > MAX_TERM_CHARS
      || /[\0\r\n]/u.test(source) || /[\0\r\n]/u.test(reading)) {
      throw new PronunciationDictionaryError("INVALID_DICTIONARY_ENTRY", `${index + 1}件目の表記または読みが不正です。`);
    }
    if (seen.has(source)) throw new PronunciationDictionaryError("DUPLICATE_DICTIONARY_ENTRY", `「${source}」が重複しています。`);
    seen.add(source);
    return { source, reading };
  });
}

function loadPronunciationDictionary(file = null) {
  // Reading without a configured file means "no dictionary"; only saving requires the path.
  if (!file && !process.env.MANUAL_PRONUNCIATION_DICTIONARY) return { version: 1, updated_at: null, entries: [] };
  const resolved = dictionaryPath(file);
  if (!fs.existsSync(resolved)) return { version: 1, updated_at: null, entries: [] };
  try {
    const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return { version: 1, updated_at: typeof value.updated_at === "string" ? value.updated_at : null, entries: normalizeEntries(value.entries) };
  } catch (error) {
    if (error instanceof PronunciationDictionaryError) throw error;
    throw new PronunciationDictionaryError("DICTIONARY_READ_FAILED", "読み辞書を読み込めません。", 500);
  }
}

function savePronunciationDictionary(entries, file = null, options = {}) {
  const resolved = dictionaryPath(file);
  const document = { version: 1, updated_at: (options.now instanceof Date ? options.now : new Date()).toISOString(), entries: normalizeEntries(entries) };
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o770 });
  const temporary = `${resolved}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o660, flag: "wx" });
    fs.renameSync(temporary, resolved);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw new PronunciationDictionaryError("DICTIONARY_WRITE_FAILED", "読み辞書を保存できません。", 500);
  }
  return document;
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

function applyPronunciationDictionary(text, dictionary) {
  const sourceText = String(text || "");
  const entries = normalizeEntries(dictionary && dictionary.entries || []).map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => Array.from(right.source).length - Array.from(left.source).length || left.index - right.index);
  if (!entries.length || !sourceText) return { text: sourceText, applied: [] };
  const bySource = new Map(entries.map((entry) => [entry.source, entry]));
  const counts = new Map();
  const pattern = new RegExp(entries.map((entry) => escapeRegExp(entry.source)).join("|"), "gu");
  const converted = sourceText.replace(pattern, (matched) => {
    counts.set(matched, (counts.get(matched) || 0) + 1);
    return bySource.get(matched).reading;
  });
  return { text: converted, applied: entries.filter((entry) => counts.has(entry.source)).map(({ source, reading }) => ({ source, reading, count: counts.get(source) })) };
}

module.exports = { PronunciationDictionaryError, applyPronunciationDictionary, dictionaryPath, loadPronunciationDictionary, normalizeEntries, savePronunciationDictionary };
