import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diffSheetRows, SheetSnapshotStore } from "../src/lib/sheet-snapshot-store.js";

test("识别单行新增而不误报后续行", () => {
  const changes = diffSheetRows(["甲", "乙", "丙"], ["甲", "新增", "乙", "丙"], 8);
  assert.deepEqual(changes, [{
    type: "added",
    rowNumber: 9,
    previousText: "",
    currentText: "新增",
  }]);
});

test("识别中文修改", () => {
  const changes = diffSheetRows(["甲", "旧文案", "丙"], ["甲", "新文案", "丙"], 8);
  assert.deepEqual(changes, [{
    type: "modified",
    rowNumber: 9,
    previousText: "旧文案",
    currentText: "新文案",
  }]);
});

test("同时识别相邻的新增和修改", () => {
  const changes = diffSheetRows(
    ["固定前文", "旧版登录提示文案", "固定后文"],
    ["固定前文", "新增登录入口", "新版登录提示文案", "固定后文"],
    8,
  );
  assert.deepEqual(changes, [
    {
      type: "added",
      rowNumber: 9,
      previousText: "",
      currentText: "新增登录入口",
    },
    {
      type: "modified",
      rowNumber: 10,
      previousText: "旧版登录提示文案",
      currentText: "新版登录提示文案",
    },
  ]);
});

test("删除不产生翻译任务", () => {
  assert.deepEqual(diffSheetRows(["甲", "乙", "丙"], ["甲", "丙"], 8), []);
});

test("行移动但内容不变时不误报", () => {
  assert.deepEqual(diffSheetRows(["甲", "乙", "丙"], ["乙", "甲", "丙"], 8), []);
});

test("并发保存历史版本不会互相覆盖或破坏文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sheet-snapshots-"));
  const path = join(directory, "snapshots.json");
  try {
    const store = new SheetSnapshotStore(path);
    store.set("doc-a", "sheet-a", { rows: ["甲"] });
    const firstSave = store.save();
    store.set("doc-b", "sheet-b", { rows: ["乙"] });
    await Promise.all([firstSave, store.save()]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(Object.keys(saved.sheets).sort(), ["doc-a:sheet-a", "doc-b:sheet-b"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
