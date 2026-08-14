const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

// Tags accepted for the Simplified-Chinese source column. "zh" alone is
// treated as the source so that headers such as `title_zh` are recognised.
const SOURCE_LANGUAGE_TAGS = new Set([
  "zh",
  "zh-hans",
  "zh-cn",
  "zh-simplified",
  "hans",
]);

// Non-standard suffixes that should resolve to a specific tag, e.g.
// `title_ft` (繁体) -> zh-Hant, `title_cn` (简体) -> zh-Hans.
const LANGUAGE_SUFFIX_ALIASES = new Map([
  ["ft", "zh-Hant"],
  ["cn", "zh-Hans"],
  ["tw", "zh-Hant"],
  ["hk", "zh-Hant"],
  ["mo", "zh-Hant"],
  ["hans", "zh-Hans"],
  ["hant", "zh-Hant"],
]);

// Base ISO 639-1 codes used for relaxed suffix detection. A couple of
// ambiguous 2-letter codes that commonly appear as column suffixes
// (id -> Indonesian, no -> Norwegian) are intentionally omitted so that
// columns such as `timbre_id` / `seq_no` are not mistaken for language
// columns. They remain recognisable via plain names or the
// `(语言标签 xx)` form.
const KNOWN_LANGUAGE_BASE_CODES = new Set([
  "aa", "ab", "af", "ak", "am", "ar", "as", "ay", "az",
  "ba", "be", "bg", "bh", "bi", "bm", "bn", "bo", "br", "bs",
  "ca", "ce", "ch", "co", "cr", "cs", "cu", "cv", "cy",
  "da", "de", "dv", "dz",
  "ee", "el", "en", "eo", "es", "et", "eu",
  "fa", "ff", "fi", "fj", "fo", "fr", "fy",
  "ga", "gd", "gl", "gn", "gu", "gv",
  "ha", "he", "hi", "ho", "hr", "ht", "hu", "hy", "hz",
  "ia", "ie", "ig", "ii", "ik", "io", "is", "it", "iu",
  "ja", "jv",
  "ka", "kg", "ki", "kj", "kk", "kl", "km", "kn", "ko", "kr", "ks", "ku", "kv", "kw", "ky",
  "la", "lb", "lg", "ln", "lo", "lt", "lu", "lv",
  "mg", "mh", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my",
  "na", "nb", "nd", "ne", "ng", "nl", "nn", "nr", "nv", "ny",
  "oc", "oj", "om", "or", "os",
  "pa", "pi", "pl", "ps", "pt",
  "qu",
  "rm", "rn", "ro", "ru", "rw",
  "sa", "sc", "sd", "se", "sg", "si", "sk", "sl", "sm", "sn", "so", "sq", "sr", "ss", "st", "su", "sv", "sw",
  "ta", "te", "tg", "th", "ti", "tk", "tl", "tn", "to", "tr", "ts", "tt", "tw", "ty",
  "ug", "uk", "ur", "uz",
  "ve", "vi", "vo",
  "wa", "wo",
  "xh",
  "yi", "yo",
  "za", "zh", "zu",
]);

function isKnownBaseCode(token) {
  return KNOWN_LANGUAGE_BASE_CODES.has(token);
}

function isRegionSubtag(token) {
  return /^[a-z]{2}$/.test(token) || /^[a-z0-9]{3}$/i.test(token);
}

function composeTag(base, region) {
  return `${base}-${region.toUpperCase()}`;
}

export function isSourceLanguageTag(tag) {
  return SOURCE_LANGUAGE_TAGS.has(String(tag ?? "").trim().toLowerCase());
}

// Extract a language tag from a header that embeds a language code as a
// suffix, e.g. `title_zh`, `value_en`, `subtitle_pt_br`, `name_ft`.
// Returns the tag, or null when the header does not look like a language
// column.
export function extractLanguageTagFromHeader(header) {
  const text = String(header ?? "")
    .trim()
    .toLowerCase();
  if (!text) return null;
  const tokens = text
    .split(/[_\-\s/]+/)
    .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter(Boolean);
  if (tokens.length === 0) return null;

  const last = tokens[tokens.length - 1];
  const secondLast = tokens.length >= 2 ? tokens[tokens.length - 2] : null;

  // `lang_region` form, e.g. pt_br -> pt-BR, en_us -> en-US.
  if (secondLast && isKnownBaseCode(secondLast) && isRegionSubtag(last)) {
    return composeTag(secondLast, last);
  }

  // Bare alias suffix, e.g. ft -> zh-Hant.
  if (LANGUAGE_SUFFIX_ALIASES.has(last)) {
    return LANGUAGE_SUFFIX_ALIASES.get(last);
  }

  // Known base code suffix, e.g. en, tr, ja.
  if (isKnownBaseCode(last)) {
    return last;
  }

  return null;
}

export function isLanguageMetadataRow(sourceText, targetValues = []) {
  if (!isSourceLanguageTag(sourceText)) return false;
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
