import assert from "node:assert/strict";
import test from "node:test";
import {
  getLanguageCellValue,
  isLanguageMetadataRow,
} from "../src/lib/language-metadata.js";

test("识别语言代码行", () => {
  assert.equal(isLanguageMetadataRow("zh-Hans", ["en", "fr", "de"]), true);
  assert.equal(
    isLanguageMetadataRow("登录成功", ["Login successful", "Connexion réussie"]),
    false,
  );
});

test("优先使用表格代码特殊值", () => {
  assert.equal(getLanguageCellValue("th", [{ tag: "th", sheetValue: "Th" }]), "Th");
  assert.equal(getLanguageCellValue("fr", []), "fr");
});
