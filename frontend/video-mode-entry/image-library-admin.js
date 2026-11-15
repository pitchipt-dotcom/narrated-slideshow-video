"use strict";

const grid = document.querySelector("#asset-grid");
const summary = document.querySelector("#summary");
const statusFilter = document.querySelector("#status-filter");
const sortFilter = document.querySelector("#sort-filter");
const labels = { approved: "採用", pending: "保留", excluded: "除外" };
const uploadForm = document.querySelector("#upload-form");
const uploadInput = document.querySelector("#upload-images");
const dropZone = document.querySelector("#drop-zone");
const selectedFiles = document.querySelector("#selected-files");
const uploadResult = document.querySelector("#upload-result");

function element(name, options = {}) {
  const node = document.createElement(name);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  return node;
}

function field(labelText, control) {
  const label = element("label", { text: labelText });
  label.append(control);
  return label;
}

async function save(item, card, status, note, tags, state) {
  state.textContent = "保存中…";
  const response = await fetch(`/api/image-library-admin/${encodeURIComponent(item.asset_id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-requested-with": "manual-video-ui" },
    body: JSON.stringify({ status: status.value, note: note.value, tags: tags.value.split(",").map((value) => value.trim()).filter(Boolean) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "保存できませんでした。");
  card.className = `asset-card status-${result.item.status}`;
  state.textContent = `保存しました: ${labels[result.item.status]}`;
}

function renderItem(item) {
  const card = element("article", { className: `asset-card status-${item.status}` });
  const image = element("img"); image.src = item.thumbnail_url; image.alt = item.title; image.loading = "lazy";
  const title = element("h2", { text: item.title });
  const id = element("div", { className: "meta", text: item.asset_id });
  const source = element("div", { className: "meta", text: `${item.registration_source} / ${item.original_filename} / ${item.width}×${item.height} / ${(item.size_bytes / 1048576).toFixed(1)}MB` });
  const hash = element("div", { className: "meta", text: `SHA-256 ${item.sha256 || "未記録"}` });
  const usage = element("div", { className: "meta", text: `使用 ${item.reuse_count}回 / 最終使用 ${item.last_used_at || "なし"}` });
  const status = element("select");
  for (const value of ["approved", "pending", "excluded"]) {
    const option = element("option", { text: labels[value] }); option.value = value; option.selected = item.status === value; status.append(option);
  }
  const note = element("textarea"); note.value = item.note || ""; note.maxLength = 2000;
  const tags = element("input"); tags.value = (item.tags || []).join(", "); tags.placeholder = "歩行, リハビリ, 介助";
  const button = element("button", { text: "評価を保存" }); button.type = "button";
  const state = element("p", { className: "save-state" });
  button.addEventListener("click", () => save(item, card, status, note, tags, state).catch((error) => { state.textContent = error.message; }));
  card.append(image, title, id, source, hash, usage, field("評価", status), field("メモ", note), field("タグ（カンマ区切り）", tags), button, state);
  return card;
}

async function load() {
  summary.textContent = "読み込み中…"; grid.replaceChildren();
  const query = new URLSearchParams({ status: statusFilter.value, sort: sortFilter.value });
  const response = await fetch(`/api/image-library-admin?${query}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "一覧を取得できませんでした。");
  summary.textContent = `表示 ${result.items.length}件　採用 ${result.counts.approved} / 保留 ${result.counts.pending} / 除外 ${result.counts.excluded}`;
  grid.append(...result.items.map(renderItem));
}

function describeFiles() {
  const files = [...uploadInput.files];
  selectedFiles.textContent = files.length
    ? `${files.length}枚: ${files.map((file) => `${file.name} (${(file.size / 1048576).toFixed(1)}MB)`).join(", ")}`
    : "選択されていません。最大10枚、1枚20MB、合計100MB。";
}

async function uploadImages(event) {
  event.preventDefault();
  const files = [...uploadInput.files];
  if (!files.length) { uploadResult.textContent = "画像を選択してください。"; return; }
  uploadResult.textContent = "変換・登録中です…";
  const body = new FormData();
  for (const file of files) body.append("images", file, file.name);
  body.append("note", document.querySelector("#upload-note").value);
  body.append("tags", document.querySelector("#upload-tags").value);
  body.append("rights_confirmed", document.querySelector("#rights-confirmed").checked ? "true" : "false");
  const response = await fetch("/api/image-library-admin/upload", {
    method: "POST", headers: { "x-requested-with": "manual-video-ui" }, body,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "画像を登録できませんでした。");
  uploadResult.textContent = `登録 ${result.registered}枚、重複 ${result.duplicates}枚\n${result.items.map((item) => item.duplicate ? `${item.original_filename}: ${item.message}` : `${item.original_filename}: 保留で登録`).join("\n")}`;
  uploadInput.value = ""; describeFiles(); statusFilter.value = "pending"; await load();
}

document.querySelector("#reload").addEventListener("click", () => load().catch((error) => { summary.textContent = error.message; }));
statusFilter.addEventListener("change", () => load().catch((error) => { summary.textContent = error.message; }));
sortFilter.addEventListener("change", () => load().catch((error) => { summary.textContent = error.message; }));
uploadInput.addEventListener("change", describeFiles);
uploadForm.addEventListener("submit", (event) => uploadImages(event).catch((error) => { uploadResult.textContent = error.message; }));
for (const eventName of ["dragenter", "dragover"]) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add("is-dragging"); });
for (const eventName of ["dragleave", "drop"]) dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove("is-dragging"); });
dropZone.addEventListener("drop", (event) => {
  if (event.dataTransfer && event.dataTransfer.files.length) { uploadInput.files = event.dataTransfer.files; describeFiles(); }
});
load().catch((error) => { summary.textContent = error.message; });
