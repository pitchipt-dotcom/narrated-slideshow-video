"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getApprovedAsset, listApprovedAssets, resolveLibrarySelections } = require("../backend/manual-image-library-browser");

function metadata(id, relativePath, overrides = {}) {
  return {
    asset_id: id, lifecycle: { state: overrides.state || "common" },
    quality: { status: overrides.status || "approved" }, search: { enabled: overrides.enabled !== false },
    rights: { commercial_use: overrides.commercial !== false },
    file: { relative_path: relativePath, sha256: overrides.sha256 || "a".repeat(64), width: 1280, height: 720, mime_type: "image/png" },
    content: { title: overrides.title || id, tags: ["test"] },
  };
}

(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-library-browser-test-"));
  try {
    fs.mkdirSync(path.join(root, "metadata", "common"), { recursive: true });
    fs.mkdirSync(path.join(root, "assets", "common", "test"), { recursive: true });
    for (let index = 1; index <= 3; index += 1) {
      const id = `common_browser_asset_00${index}`;
      const relative = `assets/common/test/${id}.png`;
      fs.writeFileSync(path.join(root, relative), Buffer.from(`image-${index}`));
      fs.writeFileSync(path.join(root, "metadata", "common", `${id}.json`), JSON.stringify(metadata(id, relative, { sha256: String(index).repeat(64) })));
    }
    const hiddenId = "common_browser_hidden_001";
    const hiddenRelative = `assets/common/test/${hiddenId}.png`;
    fs.writeFileSync(path.join(root, hiddenRelative), Buffer.from("hidden"));
    fs.writeFileSync(path.join(root, "metadata", "common", `${hiddenId}.json`), JSON.stringify(metadata(hiddenId, hiddenRelative, { enabled: false })));

    const first = listApprovedAssets(root, { limit: 2 });
    assert.equal(first.items.length, 2);
    assert(first.next_cursor);
    assert.equal(Object.hasOwn(first.items[0], "relative_path"), false);
    assert.match(first.items[0].thumbnail_url, /^\/api\/manual-image-library\//);
    const second = listApprovedAssets(root, { limit: 2, cursor: first.next_cursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.next_cursor, null);
    assert.throws(() => getApprovedAsset(root, hiddenId), (error) => error.code === "ASSET_NOT_FOUND");
    const selected = resolveLibrarySelections(root, [first.items[0].asset_id], { logicalRoot: "/data/library" });
    assert.equal(selected.length, 1);
    assert(selected[0].storedPath.startsWith("/data/library/assets/common/test/"));
    assert.throws(() => resolveLibrarySelections(root, [first.items[0].asset_id, first.items[0].asset_id]), (error) => error.code === "INVALID_LIBRARY_SELECTION");
    console.log("manual image library browser tests: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
