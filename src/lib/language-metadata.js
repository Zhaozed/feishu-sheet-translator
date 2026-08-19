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

// Headers that embed a BCP 47 tag inside parentheses, e.g.
// `English-(en)`, `English (en)`, `English(语言标签en)`, `简体中文-(zh-Hans)`.
const TAGGED_HEADER_PATTERN = /\((?:语言标签\s*)?[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\)/i;

// Infer the dominant style among existing tagged language headers so that a
// newly added column can follow the same convention:
// - separator: what sits between the language name and "(", e.g. `-` in
//   `English-(en)`, ` ` in `English (en)`, or `""` in `English(en)`.
// - labeled: whether the paren content uses the `语言标签` prefix.
// Returns null when no tagged header exists (plain-name or suffix style).
export function inferLanguageHeaderFormatter(headers) {
  const separatorCounts = new Map();
  const labeledCounts = new Map();
  let matched = 0;

  for (const header of headers) {
    const text = String(header ?? "").trim();
    if (!TAGGED_HEADER_PATTERN.test(text)) continue;
    const open = text.indexOf("(");
    if (open < 0) continue;
    const before = text.slice(0, open);
    const separatorMatch = before.match(/([-–—]|\s+)$/);
    const separator = separatorMatch ? separatorMatch[1] : "";
    const labeled = /\(语言标签/i.test(text);
    separatorCounts.set(separator, (separatorCounts.get(separator) ?? 0) + 1);
    labeledCounts.set(labeled, (labeledCounts.get(labeled) ?? 0) + 1);
    matched += 1;
  }

  if (matched === 0) return null;
  const pickMostCommon = (counts) =>
    [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return {
    separator: pickMostCommon(separatorCounts),
    labeled: pickMostCommon(labeledCounts),
  };
}

// Build a new language header following the inferred style, e.g.
// `瑞典语-(sv)` for `{ separator: "-", labeled: false }`,
// `泰语(语言标签th)` for `{ separator: "", labeled: true }`, or just the
// plain name when no tagged style exists.
export function buildLanguageHeader(languageName, languageTag, formatter) {
  const name = String(languageName ?? "").trim();
  if (!name) return "";
  if (!formatter) return name;
  const tag = String(languageTag ?? "").trim();
  return `${name}${formatter.separator}(${formatter.labeled ? "语言标签" : ""}${tag})`;
}

// Hard-coded self names for the language-picker keys (`rb_set_lan_*`). The
// app ships these keys with the same autonym in every locale file, so the
// target column must NOT be model-translated: `rb_set_lan_fr` is
// `Français` in the English column too, `rb_set_lan_zh-hant` is `粵語`,
// etc. Keys are lowercase; matching is case-insensitive.
const RB_SET_LAN_SELF_NAMES = {
  "rb_set_lan_ar": "العربية",
  "rb_set_lan_de": "Deutsch",
  "rb_set_lan_en": "English",
  "rb_set_lan_es": "Español",
  "rb_set_lan_fr": "Français",
  "rb_set_lan_it": "Italiano",
  "rb_set_lan_ja": "Japanese",
  "rb_set_lan_ko": "한국어",
  "rb_set_lan_nl": "Dutch",
  "rb_set_lan_pl": "Polski",
  "rb_set_lan_pt": "Português",
  "rb_set_lan_ru": "Русский",
  "rb_set_lan_zh": "简体中文",
  "rb_set_lan_zh-hant": "粵語",
};

const RB_SET_LAN_KEY_PATTERN = /^rb_set_lan_[a-z0-9-]+$/i;

// Return the fixed self-name for a `rb_set_lan_*` key (e.g.
// `rb_set_lan_fr` -> `Français`), or null when the cell is not such a key.
// The returned value is independent of the target language column.
export function getLanguageSelfName(sourceKey) {
  const key = String(sourceKey ?? "").trim();
  if (!RB_SET_LAN_KEY_PATTERN.test(key)) return null;
  return RB_SET_LAN_SELF_NAMES[key.toLowerCase()] ?? null;
}
