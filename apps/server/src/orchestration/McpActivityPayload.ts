import type { ActivityValue, ActivityRecord } from "./ActivityPayloadBounds.ts";
import * as Predicate from "effect/Predicate";
import { asRecord, projectBoundedValue } from "./ActivityPayloadBounds.ts";
import { summarizeToolTextOutput, collectChangedFiles } from "./CommandActivityPayload.ts";

/**
 * Fields of an MCP tool-call item both clients render in the expanded
 * work-log row. Everything else — notably `result`, which carries the full
 * tool output and dominates wire size on MCP-heavy threads — is summarized
 * or dropped. Full payloads remain in persistence.
 */
const MCP_ITEM_KEPT_FIELDS = [
  "type",
  "id",
  "tool",
  "server",
  "status",
  "arguments",
  "appContext",
  "error",
  "durationMs",
] as const;

/**
 * Pulls renderable text out of an MCP tool result: either a Codex-style
 * `{content: [{type: "text", text}, ...]}` record or a raw Claude
 * `tool_result` block whose `content` is a string or block array.
 */
function extractMcpResultText(result: ActivityValue): string | null {
  const record = asRecord(result);

  if (!record) {
    return Predicate.isString(result) ? result : null;
  }

  if (Predicate.isString(record.content)) {
    return record.content;
  }

  if (Array.isArray(record.content)) {
    const texts: string[] = [];

    for (const entry of record.content) {
      const text = asRecord(entry)?.text;

      if (Predicate.isString(text) && text.trim().length > 0) {
        texts.push(text);
      }
    }

    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  return null;
}

function summarizeMcpResult(result: ActivityValue): ActivityRecord | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }

  const text = extractMcpResultText(result);
  const summary = text ? summarizeToolTextOutput(text) : null;

  return summary ? { content: summary } : undefined;
}

/**
 * MCP tool calls carry full tool results (`data.item.result` on Codex,
 * `data.result` on Claude/OpenCode) that used to bypass slimming entirely to
 * keep the expanded-row UI working. Keep the fields the UI actually renders
 * and summarize the result like regular tool output.
 */
export function projectMcpToolCallData(data: ActivityRecord): ActivityRecord {
  const projectedData: ActivityRecord = {};

  const item = asRecord(data.item);

  if (item) {
    const projectedItem: ActivityRecord = {};

    for (const key of MCP_ITEM_KEPT_FIELDS) {
      if (key in item) {
        projectedItem[key] = projectBoundedValue(item[key]);
      }
    }

    const result = summarizeMcpResult(item.result);

    if (result) {
      projectedItem.result = result;
    }

    projectedData.item = projectedItem;
  }

  if ("toolName" in data) {
    projectedData.toolName = data.toolName;
  }

  if ("input" in data) {
    projectedData.input = projectBoundedValue(data.input);
  }

  if (!item) {
    const result = summarizeMcpResult(data.result);

    if (result) {
      projectedData.result = result;
    }
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }

  if ("kind" in data) {
    projectedData.kind = data.kind;
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);

  if (changedFiles.length > 0) {
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  return projectedData;
}
