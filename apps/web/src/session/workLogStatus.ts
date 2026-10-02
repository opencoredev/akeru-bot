import * as Schema from "effect/Schema";
import { AkeruPluginSearchResult, isToolLifecycleItemType } from "@akeru/contracts";
import { type WorkLogEntry } from "./workLogTypes";

export const isPluginSearchResult = Schema.is(AkeruPluginSearchResult);

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") {
    return true;
  }

  if (entry.command !== undefined && entry.command.trim().length > 0) {
    return true;
  }

  if (entry.requestKind !== undefined) {
    return true;
  }

  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

export function pluginSearchResultForWorkEntry(
  entry: WorkLogEntry,
): AkeruPluginSearchResult | null {
  return isPluginSearchResult(entry.toolData) ? entry.toolData : null;
}

/** Heuristic: providers often emit successful lifecycle status while error text lives in `detail` / `command`. */
function toolDetailTextLooksLikeFailure(text: string): boolean {
  const t = text.toLowerCase();

  if (t.includes("file not found")) {
    return true;
  }

  if (t.includes("no files found")) {
    return true;
  }

  if (
    t.includes("enoent") ||
    t.includes("no such file or directory") ||
    t.includes("no such file")
  ) {
    return true;
  }

  if (t.includes("cannot find path") && t.includes("because it does not exist")) {
    return true;
  }

  if (t.includes("commandnotfoundexception")) {
    return true;
  }

  if (t.includes("is not recognized as the name of a cmdlet")) {
    return true;
  }

  if (t.includes("is not recognized") && t.includes("the term '")) {
    return true;
  }

  if (t.includes("a parameter cannot be found that matches parameter name")) {
    return true;
  }

  if (t.includes("command not found")) {
    return true;
  }

  if (/<exited with exit code\s+[1-9]\d*\s*>/i.test(text)) {
    return true;
  }

  if (/exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text)) {
    return true;
  }

  if (/exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)) {
    return true;
  }

  return false;
}

function workEntryIndicatesToolFailureFromOutput(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") {
    return true;
  }

  const ls = entry.toolLifecycleStatus;

  if (ls === "failed" || ls === "declined") {
    return true;
  }

  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }

  const parts: string[] = [];

  if (entry.detail) {
    parts.push(entry.detail);
  }

  const blob = parts.join("\n");

  if (blob.length === 0) {
    return false;
  }

  return toolDetailTextLooksLikeFailure(blob);
}

/** True when the rendered result indicates failure. The command itself is user intent, not output. */
export function workEntryDisplayIndicatesToolFailure(entry: WorkLogEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry);
}
