import type { ActivityValue, ActivityRecord } from "./ActivityPayloadBounds.ts";
import { asTrimmedString, asRecord, projectBoundedValue } from "./ActivityPayloadBounds.ts";

function pushChangedFile(target: string[], seen: Set<string>, value: ActivityValue): void {
  const normalized = asTrimmedString(value);

  if (!normalized || seen.has(normalized)) {
    return;
  }

  seen.add(normalized);
  target.push(normalized);
}

export function collectChangedFiles(
  value: ActivityValue,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || target.length >= 12) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);

      if (target.length >= 12) {
        return;
      }
    }

    return;
  }

  const record = asRecord(value);

  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }

    collectChangedFiles(record[nestedKey], target, seen, depth + 1);

    if (target.length >= 12) {
      return;
    }
  }
}

export function projectCommandData(data: ActivityRecord): ActivityRecord | undefined {
  const item = asRecord(data.item);

  if (!item) {
    return undefined;
  }

  const projectedItem: ActivityRecord = {};

  if ("command" in item) {
    projectedItem.command = projectBoundedValue(item.command);
  }

  const aggregatedOutput = asTrimmedString(item.aggregatedOutput);

  if (aggregatedOutput) {
    const summary = summarizeToolTextOutput(aggregatedOutput);

    if (summary) {
      projectedItem.aggregatedOutput = summary;
    }
  }

  const input = asRecord(item.input);

  if (input && "command" in input) {
    projectedItem.input = { command: projectBoundedValue(input.command) };
  }

  const result = asRecord(item.result);

  if (result) {
    const projectedResult: ActivityRecord = {};

    if ("command" in result) {
      projectedResult.command = projectBoundedValue(result.command);
    }

    const content = asTrimmedString(result.content);

    if (content) {
      const summary = summarizeToolTextOutput(content);

      if (summary) {
        projectedResult.content = summary;
      }
    }

    if (Object.keys(projectedResult).length > 0) {
      projectedItem.result = projectedResult;
    }
  }

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

export function projectCommandValue(data: ActivityRecord): ActivityValue {
  if (data.command !== undefined) {
    return data.command;
  }

  const args = asRecord(data.args);

  if (args?.command !== undefined) {
    return args.command;
  }

  const input = asRecord(data.input);

  if (input?.command !== undefined) {
    return input.command;
  }

  const stateInput = asRecord(asRecord(data.state)?.input);

  if (stateInput?.command !== undefined) {
    return stateInput.command;
  }

  return undefined;
}

export function summarizeToolTextOutput(value: string): string | null {
  let meaningfulLineCount = 0;
  let offset = 0;

  while (offset <= value.length) {
    const newlineIndex = value.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? value.length : newlineIndex;
    const line = value.slice(offset, lineEnd).replace(/\s+/g, " ").trim();

    if (line.length > 0) {
      meaningfulLineCount += 1;

      if (line !== "```") {
        const summary = line.length <= 84 ? line : `${line.slice(0, 83).trimEnd()}…`;

        // Copy the preview so V8 cannot retain the full tool output behind a slice.
        return Array.from(summary).join("");
      }
    }

    if (newlineIndex === -1) {
      break;
    }

    offset = newlineIndex + 1;
  }

  return meaningfulLineCount > 1 ? `${meaningfulLineCount.toLocaleString()} lines` : null;
}
