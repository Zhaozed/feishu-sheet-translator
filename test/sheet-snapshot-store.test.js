import assert from "node:assert/strict";
import test from "node:test";
import { diffSheetRows } from "../src/lib/sheet-snapshot-store.js";

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

test("删除不产生翻译任务", () => {
  assert.deepEqual(diffSheetRows(["甲", "乙", "丙"], ["甲", "丙"], 8), []);
});

test("行移动但内容不变时不误报", () => {
  assert.deepEqual(diffSheetRows(["甲", "乙", "丙"], ["乙", "甲", "丙"], 8), []);
});
