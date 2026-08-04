import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SNAPSHOT_STORE_VERSION = 2;

export class SheetSnapshotStore {
  constructor(path) {
    this.path = path;
    this.data = { version: SNAPSHOT_STORE_VERSION, sheets: {} };
    this.savePromise = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed?.version === SNAPSHOT_STORE_VERSION) {
        this.data = { version: SNAPSHOT_STORE_VERSION, sheets: parsed?.sheets ?? {} };
      } else {
        // Version 1 contains snapshots produced by the retired diff workflow.
        // Clear them once during deployment so the next check establishes a clean baseline.
        this.data = { version: SNAPSHOT_STORE_VERSION, sheets: {} };
        await this.save();
      }
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
    this.savePromise = this.savePromise.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.path);
    });
    return this.savePromise;
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

function normalizedTextDistance(left, right) {
  const a = Array.from(left.slice(0, 200));
  const b = Array.from(right.slice(0, 200));
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function normalizeRecord(record) {
  return {
    sourceText: String(record?.sourceText ?? "").trim(),
    metadataValues: (record?.metadataValues ?? [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
    targetValues: (record?.targetValues ?? []).map((value) =>
      String(value ?? "").trim(),
    ),
  };
}

function recordMatchCost(previous, current) {
  const sourceDistance = normalizedTextDistance(
    previous.sourceText,
    current.sourceText,
  );
  const previousMetadata = previous.metadataValues.join("\u001f");
  const currentMetadata = current.metadataValues.join("\u001f");
  if (previousMetadata && currentMetadata && previousMetadata === currentMetadata) {
    return sourceDistance * 0.25;
  }
  if (previous.sourceText === current.sourceText) return 0;
  const currentTargetsBlank = current.targetValues.length > 0 &&
    current.targetValues.every((value) => !value);
  const previousTargetsFilled = previous.targetValues.some(Boolean);
  if (currentTargetsBlank && previousTargetsFilled) return 1.05;
  if (previousMetadata && currentMetadata && previousMetadata !== currentMetadata) {
    return Math.min(1.2, sourceDistance + 0.45);
  }
  return sourceDistance;
}

/**
 * Align table rows using all available row features. Metadata columns act as a
 * weak key; target occupancy helps avoid treating a newly inserted blank row as
 * an edit of an already translated row.
 */
export function diffSheetRecords(previousInput, currentInput, baseRow) {
  const previous = previousInput.map(normalizeRecord);
  const current = currentInput.map(normalizeRecord);
  if (previous.length * current.length > 40000) {
    return diffSheetRows(
      previous.map((row) => row.sourceText),
      current.map((row) => row.sourceText),
      baseRow,
    );
  }
  const gapCost = 0.62;
  const costs = Array.from(
    { length: previous.length + 1 },
    () => Array(current.length + 1).fill(0),
  );
  const moves = Array.from(
    { length: previous.length + 1 },
    () => Array(current.length + 1).fill(""),
  );
  for (let row = 1; row <= previous.length; row += 1) {
    costs[row][0] = row * gapCost;
    moves[row][0] = "delete";
  }
  for (let column = 1; column <= current.length; column += 1) {
    costs[0][column] = column * gapCost;
    moves[0][column] = "insert";
  }
  for (let row = 1; row <= previous.length; row += 1) {
    for (let column = 1; column <= current.length; column += 1) {
      const options = [
        {
          cost: costs[row - 1][column - 1] + recordMatchCost(
            previous[row - 1],
            current[column - 1],
          ),
          move: "match",
          priority: 0,
        },
        { cost: costs[row - 1][column] + gapCost, move: "delete", priority: 1 },
        { cost: costs[row][column - 1] + gapCost, move: "insert", priority: 2 },
      ].sort((left, right) => left.cost - right.cost || left.priority - right.priority);
      costs[row][column] = options[0].cost;
      moves[row][column] = options[0].move;
    }
  }
  const changes = [];
  let row = previous.length;
  let column = current.length;
  while (row > 0 || column > 0) {
    const move = moves[row][column];
    if (move === "match") {
      const oldRecord = previous[row - 1];
      const newRecord = current[column - 1];
      if (newRecord.sourceText && newRecord.sourceText !== oldRecord.sourceText) {
        const oldMetadata = oldRecord.metadataValues.join("\u001f");
        const newMetadata = newRecord.metadataValues.join("\u001f");
        changes.push({
          type: oldMetadata && oldMetadata === newMetadata
            ? "modified"
            : "uncertain",
          rowNumber: baseRow + column - 1,
          previousText: oldRecord.sourceText,
          currentText: newRecord.sourceText,
        });
      }
      row -= 1;
      column -= 1;
    } else if (move === "delete") {
      row -= 1;
    } else {
      const newRecord = current[column - 1];
      if (newRecord.sourceText) {
        changes.push({
          type: "added",
          rowNumber: baseRow + column - 1,
          previousText: "",
          currentText: newRecord.sourceText,
        });
      }
      column -= 1;
    }
  }
  return changes.reverse();
}

function alignSegment(oldSegment, newSegment) {
  if (oldSegment.length * newSegment.length > 10000) return null;
  const gapCost = 0.7;
  const costs = Array.from(
    { length: oldSegment.length + 1 },
    () => Array(newSegment.length + 1).fill(0),
  );
  const moves = Array.from(
    { length: oldSegment.length + 1 },
    () => Array(newSegment.length + 1).fill(""),
  );
  for (let row = 1; row <= oldSegment.length; row += 1) {
    costs[row][0] = row * gapCost;
    moves[row][0] = "delete";
  }
  for (let column = 1; column <= newSegment.length; column += 1) {
    costs[0][column] = column * gapCost;
    moves[0][column] = "insert";
  }
  for (let row = 1; row <= oldSegment.length; row += 1) {
    for (let column = 1; column <= newSegment.length; column += 1) {
      const options = [
        {
          cost: costs[row - 1][column - 1] + normalizedTextDistance(
            oldSegment[row - 1],
            newSegment[column - 1],
          ),
          move: "match",
        },
        { cost: costs[row - 1][column] + gapCost, move: "delete" },
        { cost: costs[row][column - 1] + gapCost, move: "insert" },
      ].sort((a, b) => a.cost - b.cost);
      costs[row][column] = options[0].cost;
      moves[row][column] = options[0].move;
    }
  }
  const aligned = [];
  let row = oldSegment.length;
  let column = newSegment.length;
  while (row > 0 || column > 0) {
    const move = moves[row][column];
    if (move === "match") {
      aligned.push({ oldIndex: row - 1, newIndex: column - 1 });
      row -= 1;
      column -= 1;
    } else if (move === "delete") {
      row -= 1;
    } else {
      aligned.push({ oldIndex: null, newIndex: column - 1 });
      column -= 1;
    }
  }
  return aligned.reverse();
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
  const aligned = alignSegment(oldMiddle, newMiddle);
  if (aligned) {
    for (const pair of aligned) {
      const previousText = pair.oldIndex === null ? "" : oldMiddle[pair.oldIndex];
      const currentText = newMiddle[pair.newIndex];
      if (!currentText || currentText === previousText) continue;
      changes.push({
        type: previousText ? "modified" : "added",
        rowNumber: baseRow + newStart + prefix + pair.newIndex,
        previousText,
        currentText,
      });
    }
    return changes;
  }
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
  const previousCounts = new Map();
  const currentCounts = new Map();
  for (const text of previousRows) {
    if (text) previousCounts.set(text, (previousCounts.get(text) ?? 0) + 1);
  }
  for (const text of currentRows) {
    if (text) currentCounts.set(text, (currentCounts.get(text) ?? 0) + 1);
  }
  const remainingAddedCounts = new Map(
    Array.from(currentCounts, ([text, count]) => [
      text,
      Math.max(0, count - (previousCounts.get(text) ?? 0)),
    ]),
  );
  return changes
    .filter((change) => {
      if (change.type !== "added") return true;
      const remaining = remainingAddedCounts.get(change.currentText) ?? 0;
      if (remaining <= 0) return false;
      remainingAddedCounts.set(change.currentText, remaining - 1);
      return true;
    })
    .sort((a, b) => a.rowNumber - b.rowNumber);
}
