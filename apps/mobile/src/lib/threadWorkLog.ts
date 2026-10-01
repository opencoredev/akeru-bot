import { Predicate } from "effect";
import {
  asRecord,
  asTrimmedString,
  extractToolCommand,
  stripTrailingExitCode,
  extractWorkLogItemType,
  extractWorkLogRequestKind,
  extractChangedFiles,
} from "@akeru/client-runtime/work-log-command";
import { isSilentRunActivity } from "@akeru/client-runtime/silent-run";
import { isToolLifecycleItemType } from "@akeru/contracts";
import type { OrchestrationThreadActivity } from "@akeru/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import type {
  CollapsedWorkLogEntry,
  DerivedWorkLogEntry,
  ThreadFeedActivity,
  WorkLogEntry,
  WorkLogToolLifecycleStatus,
} from "./threadActivityTypes";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;

/** Codex children settle via task.updated (idle/failed/interrupted), never
 * task.completed — these rows are mobile's only terminal signal for them. */
const MOBILE_TERMINAL_UPDATE_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function isTerminalBypassUpdate(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "task.updated") {
    return false;
  }

  const payload =
    activity.payload && Predicate.isObjectOrArray(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : null;

  return (
    payload?.timelineBypass === true &&
    Predicate.isString(payload.status) &&
    MOBILE_TERMINAL_UPDATE_STATUSES.has(payload.status)
  );
}

/**
 * Quiet-timeline guarantee (mirrors web's session-logic): agent-internal
 * activity lives in the Agents sheet, not the work log. Terminal rows are
 * kept — with no Agents surface on mobile they are the terminal signal
 * (a surface that hides rows must keep its own terminal signal). That means
 * task.completed (Claude) AND terminal bypassed task.updated (Codex, whose
 * children never emit task.completed — review finding).
 */
function isAgentInternalActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && Predicate.isObjectOrArray(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : null;

  if (!payload) {
    return false;
  }

  const isTerminalTaskRow = activity.kind === "task.completed" || isTerminalBypassUpdate(activity);

  if (payload.timelineBypass === true && !isTerminalTaskRow) {
    return true;
  }

  // agentId marks ownership, not "hide me": a NESTED AGENT's terminal row is
  // the only signal mobile gets (no Agents sheet), so it stays. Only an
  // agent's own background work (stamped "background") is internal — same
  // rule as web (review finding: hiding on agentId alone dropped nested
  // completions with no replacement UI).
  const ownedByAgent = Predicate.isString(payload.agentId) && payload.agentId.trim().length > 0;

  if (!ownedByAgent) {
    return false;
  }

  return !(isTerminalTaskRow && payload.agentKind === "agent");
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): CollapsedWorkLogEntry[] {
  const ordered = Arr.sort(activities, activityOrder);
  const entries: DerivedWorkLogEntry[] = [];

  for (const activity of ordered) {
    if (activity.kind === "tool.started") continue;

    if (activity.kind === "task.started") continue;

    // Terminal bypassed updates pass: Codex children's only terminal signal.
    if (activity.kind === "task.updated" && !isTerminalBypassUpdate(activity)) continue;

    if (activity.kind === "tool.progress") continue;

    if (activity.kind === "context-window.updated") continue;

    if (activity.kind === "bot.step-usage.updated") continue;

    if (activity.kind === "bot.usage-cap.hit") continue;

    // Silent-run state drives the status line; it is not work the bot did.
    if (isSilentRunActivity(activity)) continue;

    if (activity.summary === "Checkpoint captured") continue;

    if (isPlanBoundaryToolActivity(activity)) continue;

    if (isAgentInternalActivity(activity)) continue;
    entries.push(cachedDerivedWorkLogEntry(activity));
  }

  return collapseDerivedWorkLogEntries(entries);
}

// Activities are immutable and keep their identity across stream updates, so
// each one is parsed into a work-log entry once instead of on every delta.
const derivedWorkLogEntryCache = new WeakMap<OrchestrationThreadActivity, DerivedWorkLogEntry>();

function cachedDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  let entry = derivedWorkLogEntryCache.get(activity);

  if (entry === undefined) {
    entry = toDerivedWorkLogEntry(activity);
    derivedWorkLogEntryCache.set(activity, entry);
  }

  return entry;
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && Predicate.isObjectOrArray(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : null;

  return Predicate.isString(payload?.detail) && payload.detail.startsWith("ExitPlanMode:");
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && Predicate.isObjectOrArray(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : null;

  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);

  // task.updated included: terminal bypassed updates (Codex children's only
  // terminal signal) must carry task identity so they collapse per child
  // instead of stacking anonymous "Task idle" rows.
  const isTaskActivity =
    activity.kind === "task.progress" ||
    activity.kind === "task.completed" ||
    activity.kind === "task.updated";

  const taskSummary =
    isTaskActivity && Predicate.isString(payload?.summary) && payload.summary.length > 0
      ? payload.summary
      : null;

  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    Predicate.isString(payload?.detail) &&
    payload.detail.length > 0
      ? payload.detail
      : null;

  const taskLabel = taskSummary || taskDetailAsLabel;

  const taskId =
    isTaskActivity && Predicate.isString(payload?.taskId) && payload.taskId.length > 0
      ? payload.taskId
      : undefined;

  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    ...(taskId ? { taskId } : {}),
    label: taskLabel || activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
  };

  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);

  if (
    !taskDetailAsLabel &&
    payload &&
    Predicate.isString(payload.detail) &&
    payload.detail.length > 0
  ) {
    const detail = stripTrailingExitCode(payload.detail).output;

    if (detail) {
      entry.detail = detail;
    }
  }

  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }

  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }

  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }

  if (title) {
    entry.toolTitle = title;
  }

  if (itemType === "mcp_tool_call") {
    const data = asRecord(payload?.data);

    if (data?.item !== undefined) {
      entry.toolData = data.item;
    }
  }

  if (itemType) {
    entry.itemType = itemType;
  }

  if (requestKind) {
    entry.requestKind = requestKind;
  }

  let toolLifecycleStatus = extractWorkLogToolLifecycleStatus(payload);

  if (!toolLifecycleStatus && activity.kind === "tool.completed") {
    toolLifecycleStatus = "completed";
  }

  if (toolLifecycleStatus) {
    entry.toolLifecycleStatus = toolLifecycleStatus;
  }

  const collapseKey = deriveToolLifecycleCollapseKey(entry);

  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }

  return entry;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): CollapsedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  const sources: DerivedWorkLogEntry[][] = [];
  // Subagent rows collapse by identity, not adjacency (quiet-timeline
  // guarantee; mirrors web's session-logic).
  const taskRowIndex = new Map<string, number>();

  for (const entry of entries) {
    const isTaskRow =
      entry.taskId !== undefined &&
      (entry.activityKind === "task.progress" ||
        entry.activityKind === "task.completed" ||
        entry.activityKind === "task.updated");

    if (isTaskRow && entry.taskId !== undefined) {
      const existingIndex = taskRowIndex.get(entry.taskId);

      if (existingIndex !== undefined) {
        collapsed[existingIndex] = mergeDerivedWorkLogEntries(collapsed[existingIndex]!, entry);
        sources[existingIndex]!.push(entry);
        continue;
      }

      taskRowIndex.set(entry.taskId, collapsed.length);
      collapsed.push(entry);
      sources.push([entry]);
      continue;
    }

    const previous = collapsed.at(-1);

    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      sources[sources.length - 1]!.push(entry);
      continue;
    }

    collapsed.push(entry);
    sources.push([entry]);
  }

  return collapsed.map((entry, index) => ({ entry, sources: sources[index]! }));
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (previous.activityKind !== "tool.updated" && previous.activityKind !== "tool.completed") {
    return false;
  }

  if (next.activityKind !== "tool.updated" && next.activityKind !== "tool.completed") {
    return false;
  }

  if (previous.activityKind === "tool.completed") {
    return false;
  }

  return previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey;
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolLifecycleStatus = next.toolLifecycleStatus ?? previous.toolLifecycleStatus;
  const toolData = next.toolData ?? previous.toolData;

  return {
    ...previous,
    ...next,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolLifecycleStatus ? { toolLifecycleStatus } : {}),
    ...(toolData !== undefined ? { toolData } : {}),
  };
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];

  if (merged.length === 0) {
    return [];
  }

  return [...new Set(merged)];
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (entry.activityKind !== "tool.updated" && entry.activityKind !== "tool.completed") {
    return undefined;
  }

  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";

  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }

  return [itemType, normalizedLabel, detail].join("\u001f");
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

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

function toolDetailTextLooksLikeFailure(text: string): boolean {
  const normalized = text.toLowerCase();

  return (
    normalized.includes("file not found") ||
    normalized.includes("no files found") ||
    normalized.includes("enoent") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("no such file") ||
    normalized.includes("commandnotfoundexception") ||
    normalized.includes("command not found") ||
    (normalized.includes("cannot find path") && normalized.includes("because it does not exist")) ||
    (normalized.includes("is not recognized") && normalized.includes("the term '")) ||
    normalized.includes("is not recognized as the name of a cmdlet") ||
    normalized.includes("a parameter cannot be found that matches parameter name") ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
  );
}

function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") {
    return true;
  }

  if (entry.toolLifecycleStatus === "failed" || entry.toolLifecycleStatus === "declined") {
    return true;
  }

  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }

  return toolDetailTextLooksLikeFailure([entry.detail, entry.command].filter(Boolean).join("\n"));
}

function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  if (!workLogEntryIsToolLike(entry) || workEntryIndicatesToolFailure(entry)) {
    return false;
  }

  if (entry.tone === "thinking") {
    return false;
  }

  return (
    entry.toolLifecycleStatus !== "inProgress" &&
    entry.toolLifecycleStatus !== "stopped" &&
    entry.toolLifecycleStatus !== "failed" &&
    entry.toolLifecycleStatus !== "declined"
  );
}

export function workEntryStatus(entry: WorkLogEntry): ThreadFeedActivity["status"] {
  if (!workLogEntryIsToolLike(entry)) {
    return null;
  }

  if (workEntryIndicatesToolFailure(entry)) {
    return "failure";
  }

  if (workEntryIndicatesToolSuccess(entry)) {
    return "success";
  }

  return "neutral";
}

export function workEntryIcon(entry: DerivedWorkLogEntry): ThreadFeedActivity["icon"] {
  if (
    entry.activityKind === "user-input.requested" ||
    entry.activityKind === "user-input.resolved"
  ) {
    return "message";
  }

  if (entry.activityKind === "runtime.warning") return "warning";

  if (entry.requestKind === "command") return "command";

  if (entry.requestKind === "file-read") return "eye";

  if (entry.requestKind === "file-change") return "edit";

  if (entry.itemType === "command_execution" || entry.command) return "command";

  if (entry.itemType === "file_change" || (entry.changedFiles?.length ?? 0) > 0) return "edit";

  if (entry.itemType === "web_search") return "globe";

  if (entry.itemType === "image_view") return "eye";

  if (entry.itemType === "mcp_tool_call") return "wrench";

  if (entry.itemType === "dynamic_tool_call" || entry.itemType === "collab_agent_tool_call") {
    return "hammer";
  }

  if (entry.tone === "error") return "alert";

  if (entry.tone === "thinking") return "agent";

  if (entry.tone === "info") return "check";

  return "zap";
}

export function buildWorkEntryExpandedBody(entry: WorkLogEntry): string | null {
  const blocks: string[] = [];

  const appendUniqueBlock = (value: string | null | undefined) => {
    const trimmed = value?.trim();

    if (trimmed && !blocks.includes(trimmed)) {
      blocks.push(trimmed);
    }
  };

  if (entry.itemType === "mcp_tool_call" && entry.toolData !== undefined) {
    appendUniqueBlock(`MCP call\n${JSON.stringify(entry.toolData, null, 2)}`);
  }

  appendUniqueBlock(entry.rawCommand ?? entry.command);
  appendUniqueBlock(entry.detail);

  if ((entry.changedFiles?.length ?? 0) > 0) {
    appendUniqueBlock(entry.changedFiles!.join("\n"));
  }

  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

export function workEntryHasExpandedBody(entry: WorkLogEntry): boolean {
  return (
    (entry.itemType === "mcp_tool_call" && entry.toolData !== undefined) ||
    Boolean((entry.rawCommand ?? entry.command)?.trim()) ||
    Boolean(entry.detail?.trim()) ||
    (entry.changedFiles?.some((path) => path.trim().length > 0) ?? false)
  );
}

export function memoizeValue<T>(build: () => T): () => T {
  let value: T;
  let initialized = false;

  return () => {
    if (!initialized) {
      value = build();
      initialized = true;
    }

    return value;
  };
}

export function workEntryPreview(
  workEntry: Pick<WorkLogEntry, "detail" | "command" | "changedFiles">,
): string | null {
  if (workEntry.command) return workEntry.command;

  if (workEntry.detail) return workEntry.detail;

  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];

  if (!firstPath) return null;

  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return value;
  }

  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function workEntryHeading(workEntry: WorkLogEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }

  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractWorkLogToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogToolLifecycleStatus | undefined {
  const status = payload?.status;

  if (
    status === "inProgress" ||
    status === "completed" ||
    status === "failed" ||
    status === "declined" ||
    status === "stopped"
  ) {
    return status;
  }

  return undefined;
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }

  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }

  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }

  return 1;
}

export const activityOrder = Order.combineAll<OrchestrationThreadActivity>([
  Order.mapInput(Order.Number, (activity) => activity.sequence ?? Number.MAX_SAFE_INTEGER),
  Order.mapInput(Order.String, (activity) => activity.createdAt),
  Order.mapInput(Order.Number, (activity) => compareActivityLifecycleRank(activity.kind)),
  Order.mapInput(Order.String, (activity) => activity.id),
]);
