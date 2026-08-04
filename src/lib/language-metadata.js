const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function isLanguageMetadataRow(sourceText, targetValues = []) {
  if (String(sourceText ?? "").trim().toLowerCase() !== "zh-hans") return false;
  return targetValues.filter((value) =>
    LANGUAGE_CODE_PATTERN.test(String(value ?? "").trim()),
  ).length >= 2;
}

export function getLanguageCellValue(languageTag, registry = []) {
  const normalizedTag = String(languageTag ?? "").toLowerCase();
  const configured = registry.find(
    (item) => String(item.tag ?? "").toLowerCase() === normalizedTag,
  );
  return configured?.sheetValue || languageTag;
}
