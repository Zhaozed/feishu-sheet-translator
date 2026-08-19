import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLanguageHeader,
  extractLanguageTagFromHeader,
  getLanguageCellValue,
  inferLanguageHeaderFormatter,
  isLanguageMetadataRow,
  isSourceLanguageTag,
} from "../src/lib/language-metadata.js";

test("识别语言代码行", () => {
  assert.equal(isLanguageMetadataRow("zh-Hans", ["en", "fr", "de"]), true);
  assert.equal(isLanguageMetadataRow("zh", ["en", "fr", "de"]), true);
  assert.equal(
    isLanguageMetadataRow("登录成功", ["Login successful", "Connexion réussie"]),
    false,
  );
});

test("优先使用表格代码特殊值", () => {
  assert.equal(getLanguageCellValue("th", [{ tag: "th", sheetValue: "Th" }]), "Th");
  assert.equal(getLanguageCellValue("fr", []), "fr");
});

test("从带语言代码后缀的表头提取语言标签", () => {
  const cases = {
    title_zh: "zh",
    title_en: "en",
    title_tr: "tr",
    title_ja: "ja",
    title_ft: "zh-Hant",
    title_ru: "ru",
    title_ko: "ko",
    title_ar: "ar",
    title_de: "de",
    title_pl: "pl",
    title_pt: "pt",
    title_es: "es",
    title_pt_br: "pt-BR",
    title_hr: "hr",
    title_sl: "sl",
    title_el: "el",
    title_sv: "sv",
    title_he: "he",
    title_it: "it",
    title_fr: "fr",
    title_th: "th",
    title_zh_cn: "zh-CN",
    title_en_us: "en-US",
    title_zh_tw: "zh-TW",
    title_cn: "zh-Hans",
    "pt-BR": "pt-BR",
    zh: "zh",
    "zh-Hans": "zh-Hans",
  };
  for (const [header, expected] of Object.entries(cases)) {
    assert.equal(
      extractLanguageTagFromHeader(header),
      expected,
      `${header} 应解析为 ${expected}`,
    );
  }
});

test("非语言列不应被误识别", () => {
  const nonLanguage = [
    "timbre_id",
    "type",
    "timbre_type",
    "user_id",
    "seq_no",
    "locale",
    "key",
    "name",
    "description",
    "title",
    "english",
    "简体中文",
    "繁体中文",
    "",
  ];
  for (const header of nonLanguage) {
    assert.equal(extractLanguageTagFromHeader(header), null, `${header} 不应被识别为语言列`);
  }
});

test("简体中文源语言标签识别", () => {
  assert.equal(isSourceLanguageTag("zh"), true);
  assert.equal(isSourceLanguageTag("zh-Hans"), true);
  assert.equal(isSourceLanguageTag("zh-CN"), true);
  assert.equal(isSourceLanguageTag("zh-tw"), false);
  assert.equal(isSourceLanguageTag("zh-Hant"), false);
  assert.equal(isSourceLanguageTag("ft"), false);
  assert.equal(isSourceLanguageTag("en"), false);
});

test("裸语言代码表头能被识别", () => {
  for (const code of ["sv", "tr", "th", "en", "ja"]) {
    assert.equal(extractLanguageTagFromHeader(code), code, `${code} 应识别为语言列`);
  }
});

test("推断现有语言列表头风格", () => {
  assert.deepEqual(
    inferLanguageHeaderFormatter(["简体中文-(zh-Hans)", "English-(en)", "French-(fr)"]),
    { separator: "-", labeled: false },
  );
  assert.deepEqual(
    inferLanguageHeaderFormatter(["简体中文(语言标签zh-Hans)", "English(语言标签en)"]),
    { separator: "", labeled: true },
  );
  assert.deepEqual(
    inferLanguageHeaderFormatter(["English (en)", "French (fr)"]),
    { separator: " ", labeled: false },
  );
  assert.equal(
    inferLanguageHeaderFormatter(["简体中文", "English", "title_en"]),
    null,
  );
  assert.equal(inferLanguageHeaderFormatter([]), null);
});

test("按现有风格构造新语言表头", () => {
  assert.equal(
    buildLanguageHeader("瑞典语", "sv", { separator: "-", labeled: false }),
    "瑞典语-(sv)",
  );
  assert.equal(
    buildLanguageHeader("土耳其语", "tr", { separator: " ", labeled: false }),
    "土耳其语 (tr)",
  );
  assert.equal(
    buildLanguageHeader("泰语", "th", { separator: "", labeled: true }),
    "泰语(语言标签th)",
  );
  assert.equal(buildLanguageHeader("越南语", "vi", null), "越南语");
});
