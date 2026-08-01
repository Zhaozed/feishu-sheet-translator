import "dotenv/config";
import * as Lark from "@larksuiteoapi/node-sdk";
import OpenAI from "openai";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const aiApiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
const aiBaseUrl = process.env.AI_BASE_URL || "https://api.deepseek.com";
const aiModel = process.env.AI_MODEL || process.env.OPENAI_MODEL || "deepseek-v4-flash";

if (!appId || !appSecret) {
  console.error(
    "缺少飞书应用凭证。请复制 .env.example 为 .env，并填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET。",
  );
  process.exit(1);
}

const baseConfig = {
  appId,
  appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
};

const client = new Lark.Client({
  ...baseConfig,
  // 避免 SDK 在请求失败时把完整请求头（含访问令牌）打印到终端。
  loggerLevel: Lark.LoggerLevel.fatal,
});
const wsClient = new Lark.WSClient({
  ...baseConfig,
  loggerLevel: Lark.LoggerLevel.info,
});
const aiClient = aiApiKey
  ? new OpenAI({ apiKey: aiApiKey, baseURL: aiBaseUrl })
  : null;

const processedMessageIds = new Set();
const pendingConfirmations = new Map();
const pendingFullTableTranslations = new Map();
const MAX_COLUMNS_RANGE = "CV";
const HEADER_SCAN_ROW_COUNT = 20;
const TRANSLATION_CONCURRENCY = 4;
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const TRANSIENT_RETRY_COUNT = 3;
const LANGUAGE_REGISTRY_PATH = new URL("../data/languages.json", import.meta.url);
let customLanguageRegistry = [];
const LANGUAGE_NAMES = {
  en: "English",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  ja: "Japanese",
  nl: "Dutch",
  ar: "Modern Standard Arabic",
  ko: "Korean",
  "zh-hant": "general Traditional Chinese without Cantonese colloquialisms",
  ru: "Russian",
  pt: "Portuguese",
  pl: "Polish",
};
const PLAIN_LANGUAGE_HEADERS = new Map(
  Object.entries({
    "zh-Hans": ["简体中文", "簡體中文", "简体", "簡體", "中文(简体)", "中文(簡體)", "Simplified Chinese"],
    en: ["English", "英语", "英語"],
    fr: ["French", "法语", "法語"],
    de: ["German", "德语", "德語"],
    es: ["Spanish", "西班牙语", "西班牙語"],
    it: ["Italian", "意大利语", "意大利語"],
    ja: ["Japanese", "日语", "日語", "日本语", "日本語"],
    nl: ["Dutch", "荷兰语", "荷蘭語"],
    ar: ["Arabic", "阿拉伯语", "阿拉伯語"],
    ko: ["Korean", "韩语", "韓語", "朝鲜语", "朝鮮語"],
    "zh-Hant": ["繁体中文", "繁體中文", "繁体", "繁體", "中文(繁体)", "中文(繁體)", "Traditional Chinese"],
    ru: ["Russian", "俄语", "俄語"],
    pt: ["Portuguese", "葡萄牙语", "葡萄牙語"],
    pl: ["Polish", "波兰语", "波蘭語"],
  }).flatMap(([tag, aliases]) =>
    aliases.map((alias) => [normalizeLanguageHeader(alias), tag]),
  ),
);

async function loadLanguageRegistry() {
  try {
    const content = await readFile(LANGUAGE_REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(content);
    customLanguageRegistry = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("[语言注册表] 读取失败，将使用内置语言配置", error.message);
    }
    customLanguageRegistry = [];
  }
}

async function saveLanguageRegistry() {
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(
    LANGUAGE_REGISTRY_PATH,
    `${JSON.stringify(customLanguageRegistry, null, 2)}\n`,
    "utf8",
  );
}

await loadLanguageRegistry();

function readText(content) {
  try {
    return JSON.parse(content ?? "{}").text?.trim() ?? "";
  } catch {
    return "";
  }
}

function isTransientNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network error|fetch failed|502|503|504/i.test(
    message,
  );
}

async function withTransientRetry(operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= TRANSIENT_RETRY_COUNT; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt === TRANSIENT_RETRY_COUNT) {
        throw error;
      }
      console.warn(`[网络重试] ${label}，第${attempt}次失败`, error.message);
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function replyToMessage(messageId, text) {
  await client.im.v1.message.reply({
    path: {
      message_id: messageId,
    },
    data: {
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

function buildModeSelectionCard() {
  return buildMessageCard(
    "请选择翻译模式",
    [
      "**补充现有语言**\n新增了一行或几行中文，补齐表格中已经存在的全部目标语言。",
      "",
      "**新增语种并全表翻译**\n在表格末尾追加一个新语言列，并把全部有效简体中文翻译后回填。",
    ].join("\n"),
    {
      template: "blue",
      buttons: [
        { name: "open_existing_translation", text: "补充现有语言", type: "primary" },
        { name: "open_new_locale_translation", text: "新增语种并全表翻译" },
      ],
    },
  );
}

function buildTranslationFormCard() {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: false,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "补充现有语言",
      },
    },
    elements: [
      {
        tag: "markdown",
        content:
          "**使用前请确认：**\n1. 目标行的 **简体中文列必须有内容**，否则无法翻译。\n2. 表头需包含“简体中文”和至少一个目标语言列。\n3. 机器人必须拥有该表格的编辑权限。\n4. 已有译文不会直接覆盖，机器人会再次请求确认。",
      },
      {
        tag: "form",
        name: "translation_form",
        elements: [
          {
            tag: "input",
            name: "sheet_url",
            required: true,
            width: "fill",
            label: {
              tag: "plain_text",
              content: "飞书电子表格链接",
            },
            placeholder: {
              tag: "plain_text",
              content: "粘贴 /sheets/ 或 /wiki/ 链接",
            },
          },
          {
            tag: "input",
            name: "start_row",
            required: true,
            width: "fill",
            max_length: 6,
            label: {
              tag: "plain_text",
              content: "起始行（仅填写数字）",
            },
            placeholder: {
              tag: "plain_text",
              content: "例如：8",
            },
          },
          {
            tag: "input",
            name: "end_row",
            required: false,
            width: "fill",
            max_length: 6,
            label: {
              tag: "plain_text",
              content: "结束行（选填，仅填写数字）",
            },
            placeholder: {
              tag: "plain_text",
              content: "留空只翻译起始行；批量时例如：20",
            },
          },
          {
            tag: "button",
            name: "submit_translation",
            action_type: "form_submit",
            type: "primary",
            text: {
              tag: "plain_text",
              content: "开始翻译",
            },
            value: {
              action: "submit_translation",
            },
          },
        ],
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "已有译文时会再次询问是否覆盖，不会直接改写。",
          },
        ],
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "default",
            text: { tag: "plain_text", content: "返回模式选择" },
            value: { action: "open_mode_selection" },
          },
        ],
      },
    ],
  };
}

function buildNewLocaleTranslationFormCard() {
  return {
    config: { wide_screen_mode: true, update_multi: false },
    header: {
      template: "purple",
      title: { tag: "plain_text", content: "新增语种并全表翻译" },
    },
    elements: [
      {
        tag: "markdown",
        content:
          "机器人会自动识别表头风格，在最后追加新语言列，并翻译该表全部有效的简体中文行。提交后会先展示任务规模，确认后才执行。",
      },
      {
        tag: "form",
        name: "add_language_form",
        elements: [
          {
            tag: "input",
            name: "sheet_url",
            required: true,
            width: "fill",
            label: { tag: "plain_text", content: "飞书电子表格链接" },
            placeholder: { tag: "plain_text", content: "粘贴目标工作表链接" },
          },
          {
            tag: "input",
            name: "language_name",
            required: true,
            width: "fill",
            max_length: 60,
            label: { tag: "plain_text", content: "新语言的表头名称" },
            placeholder: { tag: "plain_text", content: "例如：泰语 或 Thai" },
          },
          {
            tag: "input",
            name: "language_tag",
            required: true,
            width: "fill",
            max_length: 35,
            label: { tag: "plain_text", content: "BCP 47 语言标签" },
            placeholder: { tag: "plain_text", content: "例如：th、fr-CA、zh-Hant" },
          },
          {
            tag: "button",
            name: "submit_new_locale_translation",
            action_type: "form_submit",
            type: "primary",
            text: { tag: "plain_text", content: "检查全表任务" },
            value: { action: "submit_new_locale_translation" },
          },
        ],
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "任务会跳过简体中文为空的行；不会改动现有语言列。",
          },
        ],
      },
    ],
  };
}

async function replyWithTranslationForm(messageId) {
  await replyWithCard(messageId, buildTranslationFormCard());
}

async function replyWithModeSelection(messageId) {
  await replyWithCard(messageId, buildModeSelectionCard());
}

async function replyWithNewLocaleTranslationForm(messageId) {
  await replyWithCard(messageId, buildNewLocaleTranslationFormCard());
}

async function replyWithCard(messageId, card) {
  await client.im.v1.message.reply({
    path: {
      message_id: messageId,
    },
    data: {
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
  });
}

function buildMessageCard(title, content, options = {}) {
  const { template = "blue", buttons = [] } = options;
  const elements = [{ tag: "markdown", content }];
  if (buttons.length > 0) {
    elements.push({
      tag: "action",
      actions: buttons.map((button) =>
        button.url
          ? {
              tag: "button",
              type: button.type ?? "default",
              text: { tag: "plain_text", content: button.text },
              url: button.url,
            }
          : {
              tag: "button",
              name: button.name,
              type: button.type ?? "default",
              text: { tag: "plain_text", content: button.text },
              value: { action: button.name },
            },
      ),
    });
  }
  return {
    config: { wide_screen_mode: true, update_multi: false },
    header: {
      template,
      title: { tag: "plain_text", content: title },
    },
    elements,
  };
}

function isDocumentPermissionError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return (
    error?.response?.status === 403 ||
    /403|Forbidden|1310213|91403|1063002|Permission Fail|没有.*权限|权限不足|写入被拒绝/i.test(text)
  );
}

async function replyWithPermissionCard(messageId, command, error) {
  const sheetUrl = command?.originalUrl;
  const buttons = [];
  if (sheetUrl) {
    buttons.push({ text: "打开表格并授权", url: sheetUrl, type: "primary" });
  }
  buttons.push({
    name: command?.startRow
      ? "open_existing_translation"
      : command
        ? "open_new_locale_translation"
        : "open_mode_selection",
    text: "授权后重新发起",
  });
  await replyWithCard(
    messageId,
    buildMessageCard(
      "需要表格编辑权限",
      [
        "机器人已尝试访问该表格，但飞书拒绝了读取或写入请求。",
        "",
        "**请由表格所有者或管理员完成授权：**",
        "1. 点击下方按钮打开表格。",
        "2. 在右上角 `… → 更多 → 添加文档应用`。",
        "3. 添加“产研翻译小助手”，并设置为 **可编辑**。",
        "4. 返回机器人重新发起任务。",
        "",
        "受飞书安全机制限制，未获授权的应用不能自行给自己提权。",
        error ? `\n错误信息：${formatFeishuError(error)}` : "",
      ].join("\n"),
      { template: "orange", buttons },
    ),
  );
}

async function replyWithErrorCard(messageId, error, command) {
  if (isDocumentPermissionError(error)) {
    await replyWithPermissionCard(messageId, command, error);
    return;
  }
  await replyWithCard(
    messageId,
    buildMessageCard(
      "翻译任务未完成",
      `**原因**\n${formatFeishuError(error)}\n\n请修正后重新填写。`,
      {
        template: "red",
        buttons: [
          {
            name: command?.startRow
              ? "open_existing_translation"
              : command
                ? "open_new_locale_translation"
                : "open_mode_selection",
            text: "重新填写",
            type: "primary",
          },
        ],
      },
    ),
  );
}

function getCardFormValues(action) {
  return (
    action?.form_value ??
    action?.form_values ??
    action?.value?.form_value ??
    action?.value?.form_values ??
    {}
  );
}

function getCardActionName(action) {
  return action?.name ?? action?.value?.action ?? "";
}

function parseSpreadsheetUrl(urlText) {
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("电子表格链接格式不正确。");
  }

  const sheetsTokenMatch = url.pathname.match(/\/sheets\/([^/?#]+)/);
  const wikiTokenMatch = url.pathname.match(/\/wiki\/([^/?#]+)/);
  if (!sheetsTokenMatch && !wikiTokenMatch) {
    throw new Error("链接必须是飞书电子表格或知识库链接（/sheets/ 或 /wiki/）。");
  }

  return {
    resourceType: sheetsTokenMatch ? "sheet" : "wiki",
    resourceToken: (sheetsTokenMatch ?? wikiTokenMatch)[1],
    requestedSheetId:
      url.searchParams.get("sheet") ??
      url.searchParams.get("sheet_id") ??
      undefined,
    originalUrl: url.toString(),
  };
}

function parseTranslationCommand(text) {
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  const rowMatch = text.match(/(?:第\s*)?(\d+)(?:\s*[-~～至到]\s*(\d+))?\s*行/i);

  if (!/^翻译(?:\s|：|:)/.test(text) || !urlMatch || !rowMatch) {
    return null;
  }

  const spreadsheet = parseSpreadsheetUrl(urlMatch[0]);

  const startRow = Number.parseInt(rowMatch[1], 10);
  const endRow = Number.parseInt(rowMatch[2] ?? rowMatch[1], 10);
  if (!Number.isSafeInteger(startRow) || startRow < 2) {
    throw new Error("行号必须从第2行开始；第1行默认作为表头。");
  }
  if (!Number.isSafeInteger(endRow) || endRow < startRow) {
    throw new Error("结束行必须大于或等于起始行。");
  }
  if (endRow - startRow + 1 > 100) {
    throw new Error("单次最多翻译100行，请缩小行号范围后重试。");
  }

  return {
    ...spreadsheet,
    startRow,
    endRow,
  };
}

async function resolveSpreadsheetToken(resourceType, resourceToken) {
  if (resourceType === "sheet") {
    return resourceToken;
  }

  const response = await withTransientRetry(
    () => client.wiki.v2.space.getNode({
      params: {
        token: resourceToken,
        obj_type: "wiki",
      },
    }),
    "解析知识库链接",
  );

  if (response.code !== 0) {
    throw new Error(`解析知识库链接失败：${response.msg || response.code}`);
  }

  const node = response.data?.node;
  if (!node?.obj_token) {
    throw new Error("知识库节点没有返回真实文档 Token。");
  }
  if (node.obj_type !== "sheet") {
    throw new Error(
      `该知识库链接底层类型为 ${node.obj_type ?? "未知"}，不是电子表格。`,
    );
  }

  return node.obj_token;
}

async function querySheets(spreadsheetToken) {
  const response = await withTransientRetry(
    () => client.sheets.v3.spreadsheetSheet.query({
      path: {
        spreadsheet_token: spreadsheetToken,
      },
    }),
    "读取工作表列表",
  );

  if (response.code !== 0) {
    throw new Error(`读取工作表列表失败：${response.msg || response.code}`);
  }

  return response.data?.sheets ?? [];
}

async function resolveSheet(spreadsheetToken, requestedSheetId) {
  const sheets = await querySheets(spreadsheetToken);
  if (sheets.length === 0) {
    throw new Error("电子表格中没有可读取的工作表。");
  }

  if (requestedSheetId) {
    const selected = sheets.find(
      (sheet) => sheet.sheet_id === requestedSheetId,
    );
    if (selected) {
      return selected;
    }
  }

  return (
    sheets
      .filter((sheet) => !sheet.hidden)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0] ?? sheets[0]
  );
}

async function readRange(spreadsheetToken, range) {
  const response = await withTransientRetry(
    () => client.request({
      method: "GET",
      url: `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}`,
    }),
    `读取单元格 ${range}`,
  );

  if (response.code !== 0) {
    throw new Error(`读取单元格失败：${response.msg || response.code}`);
  }

  return response.data?.valueRange?.values ?? [];
}

function normalizeCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value).trim();
}

function normalizeLanguageHeader(value) {
  return normalizeCell(value)
    .toLowerCase()
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/\s+/g, "");
}

function getLanguageTag(header) {
  const normalizedHeader = normalizeCell(header);
  const match = normalizedHeader.match(
    /\(语言标签\s*([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\)/i,
  );
  if (match) {
    return match[1];
  }

  const normalizedAlias = normalizeLanguageHeader(normalizedHeader);
  const builtInTag = PLAIN_LANGUAGE_HEADERS.get(normalizedAlias);
  if (builtInTag) {
    return builtInTag;
  }
  return customLanguageRegistry.find((item) =>
    (item.aliases ?? []).some(
      (alias) => normalizeLanguageHeader(alias) === normalizedAlias,
    ),
  )?.tag;
}

function getLanguageDisplayName(header, fallbackTag = "") {
  const displayName = normalizeCell(header)
    .replace(/\(语言标签\s*[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\)/i, "")
    .trim();
  return displayName || fallbackTag;
}

function findHeaderRow(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const headers = rows[index] ?? [];
    const tags = headers.map(getLanguageTag).filter(Boolean);
    const hasSource = tags.some((tag) => tag.toLowerCase() === "zh-hans");
    const hasTarget = tags.some((tag) => tag.toLowerCase() !== "zh-hans");

    if (hasSource && hasTarget) {
      return {
        headerRowNumber: index + 1,
        headers,
      };
    }
  }

  throw new Error(
    `前${HEADER_SCAN_ROW_COUNT}行中未找到有效语言表头。表头需包含“简体中文”或“(语言标签zh-Hans)”，并至少包含一个目标语言列（如 English、French，或对应语言标签）。`,
  );
}

function analyzeRow(headers, row, rowNumber) {
  const sourceColumn = headers.findIndex(
    (header) => getLanguageTag(header)?.toLowerCase() === "zh-hans",
  );
  if (sourceColumn < 0) {
    throw new Error("表头中没有找到“简体中文”或“(语言标签zh-Hans)”。");
  }

  const sourceText = normalizeCell(row[sourceColumn]);
  if (!sourceText) {
    throw new Error(`第${rowNumber}行的简体中文单元格为空。`);
  }

  const targets = headers
    .map((header, index) => ({
      header: normalizeCell(header),
      index,
      tag: getLanguageTag(header),
      value: normalizeCell(row[index]),
    }))
    .filter(
      (column) =>
        column.tag && column.tag.toLowerCase() !== "zh-hans",
    );

  if (targets.length === 0) {
    throw new Error("没有发现目标语言列。请使用 English、French 等语言名，或带语言标签的标准表头。");
  }

  const blankTargets = targets.filter((column) => !column.value);
  const existingTargets = targets.filter((column) => column.value);

  return {
    sourceColumn,
    sourceText,
    targets,
    blankTargets,
    existingTargets,
  };
}

function buildRowContext(headers, row) {
  const preferred = /^(功能版块|功能模块|模块|功能|说明|备注|描述|场景|key|键|标识|文案类型)$/i;
  const entries = headers
    .map((header, index) => ({
      header: normalizeCell(header),
      value: normalizeCell(row[index]),
      isLanguage: Boolean(getLanguageTag(header)),
    }))
    .filter((item) => item.header && item.value && !item.isLanguage)
    .sort((a, b) => Number(preferred.test(b.header)) - Number(preferred.test(a.header)))
    .slice(0, 8)
    .map((item) => `${item.header}: ${item.value}`);

  const context = entries.join("\n");
  return context.length > 1200 ? `${context.slice(0, 1200)}……` : context;
}

function buildPreview(sheet, headerRowNumber, rowNumber, analysis) {
  const { sourceText, targets, blankTargets, existingTargets } = analysis;
  const excerpt =
    sourceText.length > 500 ? `${sourceText.slice(0, 500)}……` : sourceText;

  return [
    "已读取目标行：",
    "",
    `工作表：${sheet.title ?? sheet.sheet_id}`,
    `表头：第${headerRowNumber}行`,
    `位置：第${rowNumber}行`,
    `源语言：zh-Hans`,
    `检测到目标语言：${targets.map((item) => item.tag).join(", ")}`,
    `空白待翻译：${blankTargets.length}列`,
    `已有内容：${existingTargets.length}列`,
    "",
    "简体中文预览：",
    excerpt,
  ].join("\n");
}

function buildBatchPreview(sheet, headerRowNumber, command, preparedRows, skippedRows) {
  if (command.startRow === command.endRow && preparedRows.length === 1) {
    return buildPreview(
      sheet,
      headerRowNumber,
      command.startRow,
      preparedRows[0].analysis,
    );
  }
  const targetTags = preparedRows[0]?.analysis.targets.map((item) => item.tag) ?? [];
  const blankCount = preparedRows.reduce(
    (sum, item) => sum + item.analysis.blankTargets.length,
    0,
  );
  const existingCount = preparedRows.reduce(
    (sum, item) => sum + item.analysis.existingTargets.length,
    0,
  );
  return [
    "已读取批量任务：",
    "",
    `工作表：${sheet.title ?? sheet.sheet_id}`,
    `表头：第${headerRowNumber}行`,
    `行号范围：第${command.startRow}–${command.endRow}行`,
    `有效中文行：${preparedRows.length}行`,
    `简体中文为空：${skippedRows.length}行`,
    `检测到目标语言：${targetTags.join(", ")}`,
    `空白待翻译：${blankCount}个单元格`,
    `已有内容：${existingCount}个单元格`,
  ].join("\n");
}

function columnIndexToLetters(index) {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function translateText(
  sourceText,
  languageTag,
  rowContext = "",
  languageNameOverride = "",
) {
  const normalizedTag = languageTag.toLowerCase();
  const customLanguage = customLanguageRegistry.find(
    (item) => item.tag?.toLowerCase() === normalizedTag,
  );
  const languageName =
    languageNameOverride ||
    (customLanguage?.modelLanguage ??
      customLanguage?.name ??
      LANGUAGE_NAMES[normalizedTag] ??
      languageTag);
  const response = await aiClient.chat.completions.create({
    model: aiModel,
    messages: [
      {
        role: "system",
        content: [
          "You are a professional localization translator for software and smart-hardware release notes.",
          `Translate Simplified Chinese into ${languageName} (language tag: ${languageTag}).`,
          "Preserve numbering, line breaks, paragraph structure, product names, and technical terms.",
          rowContext
            ? "Use the row context only to disambiguate meaning and terminology. Do not translate or include the context itself."
            : "",
          "Do not add, remove, summarize, explain, or wrap the result in Markdown.",
          "Return only the final translation.",
        ].join("\n"),
      },
      {
        role: "user",
        content: rowContext
          ? `Row context (reference only):\n${rowContext}\n\nSimplified Chinese to translate:\n${sourceText}`
          : sourceText,
      },
    ],
    thinking: { type: "disabled" },
    stream: false,
  });

  const translated = response.choices[0]?.message?.content?.trim();
  if (!translated) {
    throw new Error("模型返回空内容");
  }
  if (/please provide|请提供.*内容|无法翻译|cannot translate/i.test(translated)) {
    throw new Error("模型没有返回有效译文");
  }
  return translated;
}

async function writeRanges(spreadsheetToken, valueRanges) {
  let response;
  try {
    response = await withTransientRetry(
      () => client.request({
        method: "POST",
        url: `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_batch_update`,
        data: { valueRanges },
      }),
      "写入翻译结果",
    );
  } catch (error) {
    if (error?.response?.status === 403) {
      throw new Error(
        "表格写入被拒绝（403）：机器人目前只有阅读权限。请在该表的权限设置中，将“产研翻译小助手”改为可编辑后重试。",
      );
    }
    throw error;
  }
  if (response.code !== 0) {
    throw new Error(`写入单元格失败：${response.msg || response.code}`);
  }
}

async function writeRangesInChunks(spreadsheetToken, valueRanges, chunkSize = 100) {
  for (let index = 0; index < valueRanges.length; index += chunkSize) {
    await writeRanges(spreadsheetToken, valueRanges.slice(index, index + chunkSize));
  }
}

function formatFeishuError(error) {
  const text = error instanceof Error ? error.message : String(error);
  if (isTransientNetworkError(error)) {
    return "飞书接口网络连接临时中断，机器人已自动重试3次但仍未恢复，请稍后重新发送同一条命令。";
  }
  if (/1310213|Permission Fail/i.test(text)) {
    return [
      "机器人没有该电子表格的访问权限。",
      "请在表格右上角“…” → “更多” → “添加文档应用”，添加“产研翻译小助手”并授予编辑权限，然后重试。",
    ].join("\n");
  }
  if (/131006|wiki.*permission denied|node permission denied/i.test(text)) {
    return [
      "机器人没有该知识库节点的读取权限。",
      "请给“产研翻译小助手”授予该知识库或目标页面的访问权限，然后重试。",
    ].join("\n");
  }
  return text;
}

async function executeTranslationCommand(
  messageId,
  actorKey,
  command,
  requestedMode,
) {
  if (!aiClient) {
    throw new Error(
      "尚未配置 AI_API_KEY。请在项目 .env 文件中添加模型 API Key 后重启机器人。",
    );
  }
  const spreadsheetToken = await resolveSpreadsheetToken(
    command.resourceType,
    command.resourceToken,
  );
  const sheet = await resolveSheet(
    spreadsheetToken,
    command.requestedSheetId,
  );
  const sheetId = sheet.sheet_id;
  const [headerRows, rowRows] = await Promise.all([
    readRange(
      spreadsheetToken,
      `${sheetId}!A1:${MAX_COLUMNS_RANGE}${HEADER_SCAN_ROW_COUNT}`,
    ),
    readRange(
      spreadsheetToken,
      `${sheetId}!A${command.startRow}:${MAX_COLUMNS_RANGE}${command.endRow}`,
    ),
  ]);
  const { headerRowNumber, headers } = findHeaderRow(headerRows);
  if (command.startRow <= headerRowNumber) {
    throw new Error(
      `目标行必须位于表头之后；当前识别到表头在第${headerRowNumber}行。`,
    );
  }
  const preparedRows = [];
  const skippedRows = [];
  for (let rowNumber = command.startRow; rowNumber <= command.endRow; rowNumber += 1) {
    const row = rowRows[rowNumber - command.startRow] ?? [];
    try {
      preparedRows.push({
        rowNumber,
        row,
        analysis: analyzeRow(headers, row, rowNumber),
        rowContext: buildRowContext(headers, row),
      });
    } catch (error) {
      if (/简体中文单元格为空/.test(formatFeishuError(error))) {
        skippedRows.push(rowNumber);
      } else {
        throw error;
      }
    }
  }
  if (preparedRows.length === 0) {
    throw new Error(
      `第${command.startRow}–${command.endRow}行的简体中文列均为空，没有可翻译内容。`,
    );
  }

  const preview = buildBatchPreview(
    sheet,
    headerRowNumber,
    command,
    preparedRows,
    skippedRows,
  );
  const existingCount = preparedRows.reduce(
    (sum, item) => sum + item.analysis.existingTargets.length,
    0,
  );
  if (existingCount > 0 && !requestedMode) {
    pendingConfirmations.set(actorKey, {
      command,
      expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    });
    await replyWithCard(
      messageId,
      buildMessageCard(
        "发现已有译文",
        [
          preview,
          "",
          `**${existingCount} 个目标单元格已有内容。**`,
          "请选择本次处理方式。该确认将在 10 分钟后失效。",
        ].join("\n"),
        {
          template: "orange",
          buttons: [
            { name: "confirm_fill_blank", text: "仅填空白", type: "primary" },
            { name: "confirm_overwrite", text: "覆盖全部", type: "danger" },
            { name: "confirm_cancel", text: "取消" },
          ],
        },
      ),
    );
    return;
  }

  const mode = requestedMode ?? "fill_blank";
  const jobs = preparedRows.flatMap((item) =>
    (mode === "overwrite" ? item.analysis.targets : item.analysis.blankTargets).map(
      (target) => ({ ...item, target }),
    ),
  );

  await replyWithCard(
    messageId,
    buildMessageCard(
      "正在翻译",
      [
        preview,
        "",
        mode === "overwrite"
          ? `⏳ 正在重新翻译并覆盖 **${jobs.length}** 个目标单元格……`
          : `⏳ 正在翻译 **${jobs.length}** 个空白目标单元格……`,
      ].join("\n"),
      { template: "blue" },
    ),
  );

  if (jobs.length === 0) {
    await replyWithCard(
      messageId,
      buildMessageCard("无需翻译", "所有目标语言列都已有内容，本次没有修改表格。", {
        template: "green",
        buttons: [{ name: "reopen_form", text: "发起新翻译", type: "primary" }],
      }),
    );
    return;
  }

  const results = await mapWithConcurrency(
    jobs,
    TRANSLATION_CONCURRENCY,
    async (job) => {
      try {
        return {
          job,
          translation: await translateText(
            job.analysis.sourceText,
            job.target.tag,
            job.rowContext,
            getLanguageDisplayName(job.target.header, job.target.tag),
          ),
        };
      } catch (error) {
        return {
          job,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  const sourceColumnLetters = columnIndexToLetters(
    preparedRows[0].analysis.sourceColumn,
  );
  const latestSourceRows = await readRange(
    spreadsheetToken,
    `${sheetId}!${sourceColumnLetters}${command.startRow}:${sourceColumnLetters}${command.endRow}`,
  );
  for (const item of preparedRows) {
    const latestSource = normalizeCell(
      latestSourceRows[item.rowNumber - command.startRow]?.[0],
    );
    if (latestSource !== item.analysis.sourceText) {
      throw new Error(
        `翻译期间第${item.rowNumber}行简体中文发生变化，已停止整批回填，请重新发起。`,
      );
    }
  }

  const successes = results.filter((result) => result.translation);
  const failures = results.filter((result) => result.error);
  if (successes.length > 0) {
    await writeRangesInChunks(
      spreadsheetToken,
      successes.map((result) => {
        const column = columnIndexToLetters(result.job.target.index);
        return {
          range: `${sheetId}!${column}${result.job.rowNumber}:${column}${result.job.rowNumber}`,
          values: [[result.translation]],
        };
      }),
    );
  }

  const summary = [
    `处理行号：第${command.startRow}–${command.endRow}行`,
    `有效中文行：${preparedRows.length}行`,
    `简体中文为空跳过：${skippedRows.length}行`,
    `翻译完成并回填：${successes.length}个单元格`,
    `跳过已有内容：${mode === "overwrite" ? 0 : existingCount}个单元格`,
    `失败：${failures.length}个单元格`,
  ];
  if (failures.length > 0) {
    summary.push(
      "",
      ...failures.slice(0, 20).map(
        (result) => `第${result.job.rowNumber}行 ${result.job.target.tag}：${result.error}`,
      ),
    );
    if (failures.length > 20) {
      summary.push(`其余 ${failures.length - 20} 个失败项未在卡片中展开。`);
    }
  }
  await replyWithCard(
    messageId,
    buildMessageCard(
      failures.length > 0 ? "翻译部分完成" : "翻译完成",
      [
        summary.join("\n"),
        "",
        command.originalUrl ? `[打开当前表格](${command.originalUrl})` : "",
      ].join("\n"),
      {
        template: failures.length > 0 ? "orange" : "green",
        buttons: [
          ...(command.originalUrl
            ? [{ text: "打开当前表格", url: command.originalUrl, type: "primary" }]
            : []),
          { name: "reopen_form", text: "继续翻译" },
        ],
      },
    ),
  );
}

function inferLanguageHeaderStyle(headers) {
  const languageHeaders = headers.filter((header) => getLanguageTag(header));
  const taggedCount = languageHeaders.filter((header) =>
    /\(语言标签\s*[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\)/i.test(
      normalizeCell(header),
    ),
  ).length;
  return taggedCount > 0 && taggedCount >= languageHeaders.length / 2
    ? "tagged"
    : "plain";
}

async function readRowsInChunks(
  spreadsheetToken,
  sheetId,
  startRow,
  endRow,
  startColumn = "A",
  endColumn = MAX_COLUMNS_RANGE,
  chunkSize = 200,
) {
  const rows = [];
  for (let chunkStart = startRow; chunkStart <= endRow; chunkStart += chunkSize) {
    const chunkEnd = Math.min(endRow, chunkStart + chunkSize - 1);
    const values = await readRange(
      spreadsheetToken,
      `${sheetId}!${startColumn}${chunkStart}:${endColumn}${chunkEnd}`,
    );
    for (let index = 0; index <= chunkEnd - chunkStart; index += 1) {
      rows.push(values[index] ?? []);
    }
  }
  return rows;
}

async function prepareFullTableTranslation(
  spreadsheetCommand,
  languageName,
  languageTag,
) {
  const spreadsheetToken = await resolveSpreadsheetToken(
    spreadsheetCommand.resourceType,
    spreadsheetCommand.resourceToken,
  );
  const sheet = await resolveSheet(
    spreadsheetToken,
    spreadsheetCommand.requestedSheetId,
  );
  const sheetId = sheet.sheet_id;
  const headerRows = await readRange(
    spreadsheetToken,
    `${sheetId}!A1:${MAX_COLUMNS_RANGE}${HEADER_SCAN_ROW_COUNT}`,
  );
  const { headerRowNumber, headers } = findHeaderRow(headerRows);
  const sourceColumn = headers.findIndex(
    (header) => getLanguageTag(header)?.toLowerCase() === "zh-hans",
  );
  if (sourceColumn < 0) {
    throw new Error("没有找到简体中文源语言列。");
  }
  const normalizedTag = languageTag.toLowerCase();
  if (
    headers.some(
      (header) => getLanguageTag(header)?.toLowerCase() === normalizedTag,
    )
  ) {
    throw new Error(`该工作表已经存在语言标签 ${languageTag}，无需重复添加。`);
  }
  if (
    headers.some(
      (header) => normalizeLanguageHeader(header) === normalizeLanguageHeader(languageName),
    )
  ) {
    throw new Error(`该工作表已经存在表头“${languageName}”，无需重复添加。`);
  }

  const style = inferLanguageHeaderStyle(headers);
  const newHeader =
    style === "tagged"
      ? `${languageName}(语言标签${languageTag})`
      : languageName;
  let lastUsedColumn = -1;
  headers.forEach((header, index) => {
    if (normalizeCell(header)) {
      lastUsedColumn = index;
    }
  });
  const newColumnIndex = lastUsedColumn + 1;
  if (newColumnIndex >= 100) {
    throw new Error("当前表头已到 CV 列，机器人暂时无法继续向右新增语言列。");
  }
  const column = columnIndexToLetters(newColumnIndex);
  const configuredRowCount =
    sheet.grid_properties?.row_count ?? sheet.row_count ?? 5000;
  const maxRow = Math.min(Math.max(configuredRowCount, headerRowNumber + 1), 20000);
  const sourceColumnLetters = columnIndexToLetters(sourceColumn);
  const sourceRows = await readRowsInChunks(
    spreadsheetToken,
    sheetId,
    headerRowNumber + 1,
    maxRow,
    sourceColumnLetters,
    sourceColumnLetters,
    500,
  );
  const validRowNumbers = [];
  sourceRows.forEach((row, index) => {
    if (normalizeCell(row[0])) {
      validRowNumbers.push(headerRowNumber + 1 + index);
    }
  });
  if (validRowNumbers.length === 0) {
    throw new Error("简体中文列没有任何可翻译内容，无法创建全表翻译任务。");
  }
  return {
    spreadsheetCommand,
    spreadsheetToken,
    sheet,
    sheetId,
    headerRowNumber,
    headers,
    sourceColumn,
    style,
    newHeader,
    newColumnIndex,
    column,
    languageName,
    languageTag,
    validRowNumbers,
    lastDataRow: validRowNumbers.at(-1),
  };
}

async function showFullTableTranslationPreview(messageId, actorKey, task) {
  pendingFullTableTranslations.set(actorKey, {
    spreadsheetCommand: task.spreadsheetCommand,
    languageName: task.languageName,
    languageTag: task.languageTag,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  });
  await replyWithCard(
    messageId,
    buildMessageCard(
      "确认新增语种全表翻译",
      [
        `工作表：${task.sheet.title ?? task.sheetId}`,
        `表头：第${task.headerRowNumber}行`,
        `识别到的表头风格：${task.style === "tagged" ? "名称 + 语言标签" : "纯语言名称"}`,
        `将在 ${task.column} 列新增：**${task.newHeader}**`,
        `有效简体中文：**${task.validRowNumbers.length}行**`,
        `预计翻译并回填：**${task.validRowNumbers.length}个单元格**`,
        "",
        "确认后才会调用模型并写入表格；现有语言列不会被修改。",
        "该确认将在 10 分钟后失效。",
      ].join("\n"),
      {
        template: "orange",
        buttons: [
          { name: "confirm_full_table_translation", text: "确认并开始", type: "primary" },
          { name: "cancel_full_table_translation", text: "取消" },
          { text: "打开当前表格", url: task.spreadsheetCommand.originalUrl },
        ],
      },
    ),
  );
}

async function registerCustomLanguage(languageName, languageTag) {
  const normalizedTag = languageTag.toLowerCase();

  const existingLanguage = customLanguageRegistry.find(
    (item) => item.tag?.toLowerCase() === normalizedTag,
  );
  if (existingLanguage) {
    existingLanguage.name = existingLanguage.name || languageName;
    existingLanguage.modelLanguage = existingLanguage.modelLanguage || languageName;
    existingLanguage.aliases = Array.from(
      new Set([...(existingLanguage.aliases ?? []), languageName]),
    );
  } else {
    customLanguageRegistry.push({
      name: languageName,
      tag: languageTag,
      modelLanguage: languageName,
      aliases: [languageName],
    });
  }
  await saveLanguageRegistry();
}

async function executeFullTableTranslation(messageId, taskInput) {
  if (!aiClient) {
    throw new Error("尚未配置 AI_API_KEY，无法执行翻译。");
  }
  const task = await prepareFullTableTranslation(
    taskInput.spreadsheetCommand,
    taskInput.languageName,
    taskInput.languageTag,
  );
  await replyWithCard(
    messageId,
    buildMessageCard(
      "正在执行全表翻译",
      [
        `工作表：${task.sheet.title ?? task.sheetId}`,
        `新增语言：${task.newHeader}`,
        `待翻译：${task.validRowNumbers.length}行`,
        "",
        "⏳ 正在读取上下文、生成译文并检查源内容，请稍候……",
      ].join("\n"),
      { template: "blue" },
    ),
  );

  const allRows = await readRowsInChunks(
    task.spreadsheetToken,
    task.sheetId,
    task.headerRowNumber + 1,
    task.lastDataRow,
  );
  const jobs = task.validRowNumbers.map((rowNumber) => {
    const row = allRows[rowNumber - task.headerRowNumber - 1] ?? [];
    return {
      rowNumber,
      sourceText: normalizeCell(row[task.sourceColumn]),
      rowContext: buildRowContext(task.headers, row),
    };
  });
  const results = await mapWithConcurrency(
    jobs,
    TRANSLATION_CONCURRENCY,
    async (job) => {
      try {
        return {
          job,
          translation: await translateText(
            job.sourceText,
            task.languageTag,
            job.rowContext,
            task.languageName,
          ),
        };
      } catch (error) {
        return {
          job,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  const sourceColumnLetters = columnIndexToLetters(task.sourceColumn);
  const latestSources = await readRowsInChunks(
    task.spreadsheetToken,
    task.sheetId,
    task.headerRowNumber + 1,
    task.lastDataRow,
    sourceColumnLetters,
    sourceColumnLetters,
    500,
  );
  const conflicts = new Set();
  for (const job of jobs) {
    const latest = normalizeCell(
      latestSources[job.rowNumber - task.headerRowNumber - 1]?.[0],
    );
    if (latest !== job.sourceText) {
      conflicts.add(job.rowNumber);
    }
  }
  const successes = results.filter(
    (result) => result.translation && !conflicts.has(result.job.rowNumber),
  );
  const failures = results.filter((result) => result.error);
  const valueRanges = [
    {
      range: `${task.sheetId}!${task.column}${task.headerRowNumber}:${task.column}${task.headerRowNumber}`,
      values: [[task.newHeader]],
    },
    ...successes.map((result) => ({
      range: `${task.sheetId}!${task.column}${result.job.rowNumber}:${task.column}${result.job.rowNumber}`,
      values: [[result.translation]],
    })),
  ];
  await writeRangesInChunks(task.spreadsheetToken, valueRanges);
  await registerCustomLanguage(task.languageName, task.languageTag);

  await replyWithCard(
    messageId,
    buildMessageCard(
      failures.length > 0 || conflicts.size > 0
        ? "新增语种翻译部分完成"
        : "新增语种翻译完成",
      [
        `工作表：${task.sheet.title ?? task.sheetId}`,
        `新增表头：**${task.newHeader}**`,
        `成功回填：${successes.length}行`,
        `翻译失败：${failures.length}行`,
        `源内容变化跳过：${conflicts.size}行`,
        "",
        `[打开当前表格](${task.spreadsheetCommand.originalUrl})`,
      ].join("\n"),
      {
        template: failures.length > 0 || conflicts.size > 0 ? "orange" : "green",
        buttons: [
          { text: "打开当前表格", url: task.spreadsheetCommand.originalUrl, type: "primary" },
          { name: "open_mode_selection", text: "返回模式选择" },
        ],
      },
    ),
  );
}

async function handleTextMessage(messageId, actorKey, text) {
  if (/添加.*(?:语种|语言)|新增.*(?:语种|语言)/i.test(text)) {
    await replyWithNewLocaleTranslationForm(messageId);
    return;
  }
  if (/^(hi|hello|你好|您好)$/i.test(text)) {
    await replyWithModeSelection(messageId);
    return;
  }

  if (/^(覆盖|仅填空白|取消)$/.test(text)) {
    const pending = pendingConfirmations.get(actorKey);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingConfirmations.delete(actorKey);
      await replyWithErrorCard(messageId, "确认已失效，请重新发起翻译任务。");
      return;
    }

    pendingConfirmations.delete(actorKey);
    if (text === "取消") {
      await replyWithCard(
        messageId,
        buildMessageCard("已取消", "本次没有修改表格。", {
          template: "grey",
          buttons: [{ name: "reopen_form", text: "重新发起", type: "primary" }],
        }),
      );
      return;
    }

    await executeTranslationCommand(
      messageId,
      actorKey,
      pending.command,
      text === "覆盖" ? "overwrite" : "fill_blank",
    );
    return;
  }

  let command;
  try {
    command = parseTranslationCommand(text);
  } catch (error) {
    await replyWithErrorCard(messageId, error);
    return;
  }

  if (!command) {
    await replyWithModeSelection(messageId);
    return;
  }

  try {
    await executeTranslationCommand(messageId, actorKey, command);
  } catch (error) {
    console.error("[翻译任务失败]", formatFeishuError(error));
    await replyWithErrorCard(messageId, error, command);
  }
}

async function handleCardAction(data) {
  const event = data?.event ?? data;
  const action = event?.action ?? {};
  const actionName = getCardActionName(action);
  const messageId = event?.context?.open_message_id;
  const actorKey =
    event?.operator?.open_id ?? event?.operator?.user_id ?? messageId;

  if (!messageId || !actorKey) {
    console.error("[卡片提交失败] 缺少消息或用户标识");
    return;
  }

  if (actionName === "reopen_form") {
    await replyWithTranslationForm(messageId);
    return;
  }

  if (actionName === "open_mode_selection") {
    await replyWithModeSelection(messageId);
    return;
  }

  if (actionName === "open_existing_translation") {
    await replyWithTranslationForm(messageId);
    return;
  }

  if (actionName === "open_new_locale_translation") {
    await replyWithNewLocaleTranslationForm(messageId);
    return;
  }

  if (actionName === "submit_new_locale_translation") {
    const values = getCardFormValues(action);
    const sheetUrl = normalizeCell(values.sheet_url);
    const languageName = normalizeCell(values.language_name);
    const languageTag = normalizeCell(values.language_tag);
    let spreadsheetCommand;
    try {
      if (!languageName) {
        throw new Error("请填写新语言的表头名称。");
      }
      if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(languageTag)) {
        throw new Error("语言标签不符合 BCP 47 格式，例如 th、fr-CA 或 zh-Hant。");
      }
      spreadsheetCommand = parseSpreadsheetUrl(sheetUrl);
      const task = await prepareFullTableTranslation(
        spreadsheetCommand,
        languageName,
        languageTag,
      );
      await showFullTableTranslationPreview(messageId, actorKey, task);
    } catch (error) {
      console.error("[新增语种预检失败]", formatFeishuError(error));
      await replyWithErrorCard(messageId, error, spreadsheetCommand);
    }
    return;
  }

  if (
    actionName === "confirm_full_table_translation" ||
    actionName === "cancel_full_table_translation"
  ) {
    const pending = pendingFullTableTranslations.get(actorKey);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingFullTableTranslations.delete(actorKey);
      await replyWithErrorCard(messageId, "全表翻译确认已失效，请重新发起任务。");
      return;
    }
    pendingFullTableTranslations.delete(actorKey);
    if (actionName === "cancel_full_table_translation") {
      await replyWithCard(
        messageId,
        buildMessageCard("已取消", "未新增语言列，也没有修改表格。", {
          template: "grey",
          buttons: [{ name: "open_mode_selection", text: "返回模式选择", type: "primary" }],
        }),
      );
      return;
    }
    try {
      await executeFullTableTranslation(messageId, pending);
    } catch (error) {
      console.error("[新增语种全表翻译失败]", formatFeishuError(error));
      await replyWithErrorCard(messageId, error, pending.spreadsheetCommand);
    }
    return;
  }

  if (/^confirm_(fill_blank|overwrite|cancel)$/.test(actionName)) {
    const pending = pendingConfirmations.get(actorKey);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingConfirmations.delete(actorKey);
      await replyWithErrorCard(messageId, "确认已失效，请重新发起翻译任务。");
      return;
    }
    pendingConfirmations.delete(actorKey);
    if (actionName === "confirm_cancel") {
      await replyWithCard(
        messageId,
        buildMessageCard("已取消", "本次没有修改表格。", {
          template: "grey",
          buttons: [{ name: "reopen_form", text: "重新发起", type: "primary" }],
        }),
      );
      return;
    }
    try {
      await executeTranslationCommand(
        messageId,
        actorKey,
        pending.command,
        actionName === "confirm_overwrite" ? "overwrite" : "fill_blank",
      );
    } catch (error) {
      console.error("[卡片确认任务失败]", formatFeishuError(error));
      await replyWithErrorCard(messageId, error, pending.command);
    }
    return;
  }

  if (actionName !== "submit_translation") {
    return;
  }

  const values = getCardFormValues(action);
  const sheetUrl = normalizeCell(values.sheet_url);
  const startRow = normalizeCell(values.start_row ?? values.row_number);
  const endRow = normalizeCell(values.end_row);

  let command;
  try {
    if (!/^\d+$/.test(startRow)) {
      throw new Error("起始行只能填写数字，例如 8；不要填写“第8行”或其他字符。");
    }
    if (endRow && !/^\d+$/.test(endRow)) {
      throw new Error("结束行只能填写数字，例如 20；不批量翻译时请留空。");
    }
    command = parseTranslationCommand(
      `翻译 ${sheetUrl} 第${startRow}${endRow ? `-${endRow}` : ""}行`,
    );
    if (!command) {
      throw new Error("请填写有效的飞书电子表格链接和行号。");
    }
  } catch (error) {
    await replyWithErrorCard(messageId, error);
    return;
  }

  try {
    await executeTranslationCommand(messageId, actorKey, command);
  } catch (error) {
    console.error("[卡片翻译任务失败]", formatFeishuError(error));
    await replyWithErrorCard(messageId, error, command);
  }
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "card.action.trigger": async (data) => {
    const event = data?.event ?? data;
    const action = event?.action ?? {};
    const actionName = getCardActionName(action);
    console.log(`[收到卡片提交] ${actionName || action.tag || "unknown"}`);
    void handleCardAction(data).catch((error) => {
      console.error("[卡片处理失败]", formatFeishuError(error));
    });
    return {
      toast: {
        type: "info",
        content:
          actionName === "submit_translation"
            ? "已提交，正在读取表格……"
            : actionName === "submit_new_locale_translation"
              ? "已提交，正在扫描全表……"
              : actionName === "confirm_full_table_translation"
                ? "已确认，正在开始全表翻译……"
            : "操作已提交",
      },
    };
  },
  "im.message.receive_v1": async (data) => {
    const message = data?.message;
    const messageId = message?.message_id;

    if (!messageId || processedMessageIds.has(messageId)) {
      return;
    }
    processedMessageIds.add(messageId);

    // 长连接事件需要快速返回；超时任务后续会移到独立队列。
    if (processedMessageIds.size > 1000) {
      processedMessageIds.clear();
      processedMessageIds.add(messageId);
    }

    if (message.message_type !== "text") {
      await replyWithModeSelection(messageId);
      return;
    }

    const text = readText(message.content);
    const actorKey =
      data?.sender?.sender_id?.open_id ?? message.chat_id ?? messageId;
    console.log(`[收到消息] ${messageId}: ${text}`);
    void handleTextMessage(messageId, actorKey, text).catch((error) => {
      console.error("[消息处理失败]", error);
    });
  },
});

console.log("正在连接飞书长连接……");
await wsClient.start({ eventDispatcher });
