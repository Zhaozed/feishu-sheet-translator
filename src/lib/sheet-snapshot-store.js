import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SheetSnapshotStore {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, sheets: {} };
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      this.data = { version: 1, sheets: parsed?.sheets ?? {} };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this;
  }

  get(spreadsheetToken, sheetId) {
    return this.data.sheets[`${spreadsheetToken}:${sheetId}`];
  }

  hasSpreadsheet(spreadsheetToken) {
    return Object.keys(this.data.sheets).some((key) =>
      key.startsWith(`${spreadsheetToken}:`),
    );
  }

  size() {
    return Object.keys(this.data.sheets).length;
  }

  set(spreadsheetToken, sheetId, snapshot) {
    this.data.sheets[`${spreadsheetToken}:${sheetId}`] = snapshot;
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }
}

function trimTrailingEmpty(rows) {
  const result = rows.map((value) => String(value ?? "").trim());
  while (result.length > 0 && !result.at(-1)) result.pop();
  return result;
}

function uniqueAnchors(previousRows, currentRows) {
  const previousPositions = new Map();
  const currentPositions = new Map();
  previousRows.forEach((text, index) => {
    if (!text) return;
    const positions = previousPositions.get(text) ?? [];
    positions.push(index);
    previousPositions.set(text, positions);
  });
  currentRows.forEach((text, index) => {
    if (!text) return;
    const positions = currentPositions.get(text) ?? [];
    positions.push(index);
    currentPositions.set(text, positions);
  });
  const candidates = [];
  for (const [text, oldPositions] of previousPositions) {
    const newPositions = currentPositions.get(text);
    if (oldPositions.length === 1 && newPositions?.length === 1) {
      candidates.push({ oldIndex: oldPositions[0], newIndex: newPositions[0] });
    }
  }
  candidates.sort((a, b) => a.oldIndex - b.oldIndex);
  const tails = [];
  const tailIndices = [];
  const parents = Array(candidates.length).fill(-1);
  candidates.forEach((candidate, index) => {
    let left = 0;
    let right = tails.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (tails[middle] < candidate.newIndex) left = middle + 1;
      else right = middle;
    }
    tails[left] = candidate.newIndex;
    if (left > 0) parents[index] = tailIndices[left - 1];
    tailIndices[left] = index;
  });
  const anchors = [];
  let cursor = tailIndices.at(-1);
  while (cursor !== undefined && cursor >= 0) {
    anchors.push(candidates[cursor]);
    cursor = parents[cursor];
  }
  return anchors.reverse();
}

function diffSegment(previousRows, currentRows, oldStart, oldEnd, newStart, newEnd, baseRow) {
  const changes = [];
  const oldSegment = previousRows.slice(oldStart, oldEnd);
  const newSegment = currentRows.slice(newStart, newEnd);
  let prefix = 0;
  while (prefix < oldSegment.length && prefix < newSegment.length && oldSegment[prefix] === newSegment[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldSegment.length - prefix &&
    suffix < newSegment.length - prefix &&
    oldSegment[oldSegment.length - 1 - suffix] === newSegment[newSegment.length - 1 - suffix]
  ) suffix += 1;
  const oldMiddle = oldSegment.slice(prefix, oldSegment.length - suffix || undefined);
  const newMiddle = newSegment.slice(prefix, newSegment.length - suffix || undefined);
  const pairedLength = Math.min(oldMiddle.length, newMiddle.length);
  for (let index = 0; index < pairedLength; index += 1) {
    const previousText = oldMiddle[index];
    const currentText = newMiddle[index];
    if (!currentText || currentText === previousText) continue;
    changes.push({
      type: previousText ? "modified" : "added",
      rowNumber: baseRow + newStart + prefix + index,
      previousText,
      currentText,
    });
  }
  for (let index = pairedLength; index < newMiddle.length; index += 1) {
    const currentText = newMiddle[index];
    if (!currentText) continue;
    changes.push({
      type: "added",
      rowNumber: baseRow + newStart + prefix + index,
      previousText: "",
      currentText,
    });
  }
  return changes;
}

export function diffSheetRows(previousInput, currentInput, baseRow) {
  const previousRows = trimTrailingEmpty(previousInput);
  const currentRows = trimTrailingEmpty(currentInput);
  const anchors = uniqueAnchors(previousRows, currentRows);
  const changes = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const anchor of [...anchors, { oldIndex: previousRows.length, newIndex: currentRows.length }]) {
    changes.push(...diffSegment(
      previousRows,
      currentRows,
      oldCursor,
      anchor.oldIndex,
      newCursor,
      anchor.newIndex,
      baseRow,
    ));
    oldCursor = anchor.oldIndex + 1;
    newCursor = anchor.newIndex + 1;
  }
  return changes
    .filter((change) => change.type !== "added" || !previousRows.includes(change.currentText))
    .sort((a, b) => a.rowNumber - b.rowNumber);
}
