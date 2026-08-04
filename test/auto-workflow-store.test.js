import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoWorkflowStore } from "../src/lib/auto-workflow-store.js";

test("保存自动工作流文档与 Sheet 基线", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translator-auto-"));
  const path = join(directory, "state.json");
  const store = await new AutoWorkflowStore(path).load();
  store.setDocument("doc", { originalUrl: "https://example.test" });
  store.setSheet("doc", "sheet", { rows: { 8: "新文案" } });
  await store.save();
  const reloaded = await new AutoWorkflowStore(path).load();
  assert.equal(reloaded.getDocument("doc").originalUrl, "https://example.test");
  assert.equal(reloaded.getSheet("doc", "sheet").rows[8], "新文案");
  assert.doesNotReject(() => readFile(path, "utf8"));
});
