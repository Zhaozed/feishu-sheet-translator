import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class AutoWorkflowStore {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, documents: {}, sheets: {} };
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      this.data = {
        version: 1,
        documents: parsed?.documents ?? {},
        sheets: parsed?.sheets ?? {},
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this;
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await import("node:fs/promises").then(({ rename }) => rename(temporaryPath, this.path));
  }

  setDocument(spreadsheetToken, document) {
    this.data.documents[spreadsheetToken] = document;
  }

  getDocument(spreadsheetToken) {
    return this.data.documents[spreadsheetToken];
  }

  removeDocument(spreadsheetToken) {
    delete this.data.documents[spreadsheetToken];
    for (const key of Object.keys(this.data.sheets)) {
      if (key.startsWith(`${spreadsheetToken}:`)) delete this.data.sheets[key];
    }
  }

  listDocuments() {
    return Object.entries(this.data.documents);
  }

  setSheet(spreadsheetToken, sheetId, state) {
    this.data.sheets[`${spreadsheetToken}:${sheetId}`] = state;
  }

  getSheet(spreadsheetToken, sheetId) {
    return this.data.sheets[`${spreadsheetToken}:${sheetId}`];
  }
}
