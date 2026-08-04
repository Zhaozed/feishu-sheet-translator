import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  diffSheetRecords,
  diffSheetRows,
  SheetSnapshotStore,
} from "../src/lib/sheet-snapshot-store.js";

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

test("无 key 表插入行并修改后续文案时仍能正确对齐", () => {
  const changes = diffSheetRows(
    ["开启定位", "登录失败提示", "退出账号", "删除账号"],
    ["新增登录入口", "开启定位", "新版登录失败提示", "退出账号", "删除账号"],
    8,
  );
  assert.deepEqual(changes, [
    {
      type: "added",
      rowNumber: 8,
      previousText: "",
      currentText: "新增登录入口",
    },
    {
      type: "modified",
      rowNumber: 10,
      previousText: "登录失败提示",
      currentText: "新版登录失败提示",
    },
  ]);
});

test("重复中文被复制到新行时按增加数量识别新增", () => {
  const repeated = "本次更新内容如下：新增多语言支持";
  const changes = diffSheetRows(
    ["固定前文", repeated, "固定后文"],
    ["固定前文", repeated, repeated, repeated, "固定后文"],
    3,
  );
  assert.equal(changes.filter((change) =>
    change.type === "added" && change.currentText === repeated,
  ).length, 2);
});

test("重复中文只移动位置且数量不变时不误报", () => {
  const repeated = "重复文案";
  assert.deepEqual(
    diffSheetRows([repeated, "中间内容", repeated], [repeated, repeated, "中间内容"], 3),
    [],
  );
});

test("删除不产生翻译任务", () => {
  assert.deepEqual(diffSheetRows(["甲", "乙", "丙"], ["甲", "丙"], 8), []);
});

test("行移动但内容不变时不误报", () => {
  assert.deepEqual(diffSheetRows(["甲", "乙", "丙"], ["乙", "甲", "丙"], 8), []);
});

test("完整行特征使用非语言列作为弱 Key 识别中文修改", () => {
  const changes = diffSheetRecords(
    [
      { sourceText: "旧登录文案", metadataValues: ["1.2.0", "登录"], targetValues: ["Old login"] },
      { sourceText: "固定文案", metadataValues: ["1.2.0", "首页"], targetValues: ["Home"] },
    ],
    [
      { sourceText: "新登录文案", metadataValues: ["1.2.0", "登录"], targetValues: ["Old login"] },
      { sourceText: "固定文案", metadataValues: ["1.2.0", "首页"], targetValues: ["Home"] },
    ],
    3,
  );
  assert.deepEqual(changes, [{
    type: "modified",
    rowNumber: 3,
    previousText: "旧登录文案",
    currentText: "新登录文案",
  }]);
});

test("完整行特征将目标语言全空的新行识别为新增", () => {
  const changes = diffSheetRecords(
    [
      { sourceText: "固定前文", metadataValues: ["A"], targetValues: ["Fixed"] },
      { sourceText: "旧文案", metadataValues: ["B"], targetValues: ["Old"] },
    ],
    [
      { sourceText: "固定前文", metadataValues: ["A"], targetValues: ["Fixed"] },
      { sourceText: "新增文案", metadataValues: ["C"], targetValues: [""] },
      { sourceText: "旧文案", metadataValues: ["B"], targetValues: ["Old"] },
    ],
    3,
  );
  assert.deepEqual(changes, [{
    type: "added",
    rowNumber: 4,
    previousText: "",
    currentText: "新增文案",
  }]);
});

test("没有弱 Key 时不强行把模糊配对声明为修改", () => {
  assert.deepEqual(
    diffSheetRecords(
      [{ sourceText: "旧文案", metadataValues: [], targetValues: ["Old"] }],
      [{ sourceText: "新文案", metadataValues: [], targetValues: ["Existing"] }],
      5,
    ),
    [{
      type: "uncertain",
      rowNumber: 5,
      previousText: "旧文案",
      currentText: "新文案",
    }],
  );
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
