import * as Predicate from "effect/Predicate";
import {
  asRecord,
  extractToolCommand,
  stripTrailingExitCode,
  extractWorkLogItemType,
  extractWorkLogRequestKind,
  extractChangedFiles,
} from "@akeru/client-runtime/work-log-command";
import { isSilentRunActivity } from "@akeru/client-runtime/silent-run";
import { isBackgroundTaskActivity } from "@akeru/client-runtime/state/subagentRuntime";
import { type OrchestrationThreadActivity } from "@akeru/contracts";
import { type WorkLogEntry, type WorkLogToolLifecycleStatus } from "./workLogTypes";
import {
  extractToolTitle,
  extractToolDetail,
  extractToolCallId,
  normalizeCompactToolLabel,
} from "./workLogToolDetail";
import { isPluginSearchResult } from "./workLogStatus";

const workLogCollapseKey = Symbol();

interface DerivedWorkLogEntry extends WorkLogEntry {
  sourceActivityKind: OrchestrationThreadActivity["kind"];
  [workLogCollapseKey]?: string;
  toolCallId?: string;
  isWorkflowCoordinator?: boolean;
  /** Shell/monitor/plan tasks: ordinary work-log rows, never spawn CTAs. */
  isBackgroundTask?: boolean;
}

const derivedWorkLogEntryByActivity = new WeakMap<
  OrchestrationThreadActivity,
  DerivedWorkLogEntry
>();

/**
 * Quiet-timeline guarantee: the work log carries the parent's narrative plus
 * at most one row per agent. Everything an agent does internally lives in the
 * Agents surface:
 * - timelineBypass rows (Codex children, workflow members) never render here;
 * - tool rows attributed to an owning agent (payload.agentId) are re-homed;
 * - task.progress ticks collapse into one row per taskId;
 * - task.updated is fold input only (status patches are not narrative).
 * Unattributed rows always stay: over-hiding loses the only terminal signal.
 */
/** Agent (non-background) task.started rows seed spawn CTA batches. */
function isAgentTaskStartedActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && (activity.payload === null || Predicate.isObjectOrArray(activity.payload))
      ? (activity.payload as Record<string, unknown>)
      : null;

  if (!payload || !Predicate.isString(payload.taskId)) {
    return false;
  }

  return !isBackgroundTaskActivity(payload);
}

function isAgentInternalActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && (activity.payload === null || Predicate.isObjectOrArray(activity.payload))
      ? (activity.payload as Record<string, unknown>)
      : null;

  if (!payload) {
    return false;
  }

  const isTaskRow =
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.updated" ||
    activity.kind === "task.completed";

  // Task rows classify by the server stamp: a subagent's own background
  // shell (agentId + "background") is agent-internal, but a nested AGENT
  // (agentId + "agent") stays visible so its rows can anchor a spawn CTA
  // (review finding: hiding on agentId alone removed nested agents and
  // their anchors). Bypassed agent lifecycle rows also pass — collapse
  // folds every such row into its batch's single CTA row, which is how
  // Codex children (whose rows are ALL bypassed) get an anchor at the
  // spawn point.
  if (isTaskRow) {
    const ownedByAgent = Predicate.isString(payload.agentId) && payload.agentId.trim().length > 0;

    if (ownedByAgent || payload.timelineBypass === true) {
      const isAgentTaskRow =
        activity.kind !== "task.updated" &&
        Predicate.isString(payload.taskId) &&
        !isBackgroundTaskActivity(payload);

      return !isAgentTaskRow;
    }

    return false;
  }

  if (payload.timelineBypass === true) {
    return true;
  }

  // Non-task rows (attributed tool activity) owned by an agent are internal.
  return Predicate.isString(payload.agentId) && payload.agentId.trim().length > 0;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries: DerivedWorkLogEntry[] = [];

  for (const activity of ordered) {
    if (activity.kind === "tool.started") continue;

    // Agent task.started rows are CTA seeds: they carry the true spawn turn,
    // which is the batch key (completions of background subagents arrive
    // under later synthetic turns and must not start new batches). They
    // collapse into the batch's single CTA row, never render standalone.
    if (activity.kind === "task.started" && !isAgentTaskStartedActivity(activity)) continue;

    if (activity.kind === "task.updated") continue;

    if (activity.kind === "tool.progress") continue;

    if (activity.kind === "context-window.updated") continue;

    if (activity.summary === "Checkpoint captured") continue;

    // Silent-run state drives the status line; it is not work the bot did.
    if (isSilentRunActivity(activity)) continue;

    if (isPlanBoundaryToolActivity(activity)) continue;

    if (isAgentInternalActivity(activity)) continue;
    entries.push(toDerivedWorkLogEntry(activity));
  }

  return collapseDerivedWorkLogEntries(entries);
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && (activity.payload === null || Predicate.isObjectOrArray(activity.payload))
      ? (activity.payload as Record<string, unknown>)
      : null;

  return Predicate.isString(payload?.detail) && payload.detail.startsWith("ExitPlanMode:");
}

function extractWorkLogToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogToolLifecycleStatus | undefined {
  if (!payload) {
    return undefined;
  }

  const s = payload.status;

  if (
    s === "inProgress" ||
    s === "completed" ||
    s === "failed" ||
    s === "declined" ||
    s === "stopped"
  ) {
    return s;
  }

  return undefined;
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const cachedEntry = derivedWorkLogEntryByActivity.get(activity);

  if (cachedEntry) {
    return cachedEntry;
  }

  const payload =
    activity.payload && (activity.payload === null || Predicate.isObjectOrArray(activity.payload))
      ? (activity.payload as Record<string, unknown>)
      : null;

  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);

  const isTaskActivity =
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.completed";

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

  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      Predicate.isString(payload.detail) &&
      payload.detail.length > 0
      ? stripTrailingExitCode(payload.detail).output
      : null
    : extractToolDetail(payload, title ?? activity.summary);

  const toolCallId = isTaskActivity ? null : extractToolCallId(payload);

  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    label: taskLabel || activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    sourceActivityKind: activity.kind,
  };

  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);

  if (detail) {
    entry.detail = detail;
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
  } else if (itemType === "dynamic_tool_call") {
    const data = asRecord(payload?.data);

    if (isPluginSearchResult(data?.result)) {
      entry.toolData = data.result;
    }
  }

  if (itemType) {
    entry.itemType = itemType;
  }

  if (requestKind) {
    entry.requestKind = requestKind;
  }

  if (toolCallId) {
    entry.toolCallId = toolCallId;
  }

  let toolLifecycleStatus = extractWorkLogToolLifecycleStatus(payload);

  if (!toolLifecycleStatus && activity.kind === "tool.completed") {
    toolLifecycleStatus = "completed";
  }

  if (toolLifecycleStatus) {
    entry.toolLifecycleStatus = toolLifecycleStatus;
  }

  if (isTaskActivity && Predicate.isString(payload?.taskId) && payload.taskId.length > 0) {
    entry.taskId = payload.taskId;
  }

  if (isTaskActivity && Predicate.isString(payload?.role) && payload.role.length > 0) {
    entry.agentRole = payload.role;
  }

  if (
    isTaskActivity &&
    (payload?.taskType === "local_workflow" ||
      (Predicate.isString(payload?.workflowName) && payload.workflowName.length > 0))
  ) {
    entry.isWorkflowCoordinator = true;
  }

  if (isTaskActivity && payload && isBackgroundTaskActivity(payload)) {
    entry.isBackgroundTask = true;
  }

  const collapseKey = deriveToolLifecycleCollapseKey(entry);

  if (collapseKey) {
    entry[workLogCollapseKey] = collapseKey;
  }

  derivedWorkLogEntryByActivity.set(activity, entry);

  return entry;
}

/**
 * Spawn-group key for a subagent lifecycle row. Workflow members and their
 * coordinator share the coordinator's group; direct spawns batch per turn.
 * One CTA row per group (A1 design): "Kicked off N subagents".
 */
function agentSpawnGroupKey(entry: DerivedWorkLogEntry): string {
  const taskId = entry.taskId ?? "";
  const workflowSlot = taskId.indexOf(":wf:");

  if (workflowSlot !== -1) {
    return `wf:${taskId.slice(0, workflowSlot)}`;
  }

  if (entry.agentSpawn?.workflowId) {
    return `wf:${entry.agentSpawn.workflowId}`;
  }

  if (entry.isWorkflowCoordinator) {
    return `wf:${taskId}`;
  }

  // No turn id means no batch signal at all: fall back to one group per
  // task. Unrelated turn-less spawns (separate fleets whose rows lost their
  // turn) must not collapse into one immortal "direct:no-turn" CTA
  // accumulating every agent the thread ever ran (review finding). Adapters
  // stamp spawn turns (Codex spawnTurnId; Claude rows ride real turns), so
  // this path is defensive.
  return entry.turnId ? `direct:${entry.turnId}` : `direct:task:${taskId}`;
}

function toolLifecycleCollapseMapKey(entry: DerivedWorkLogEntry): string | undefined {
  if (
    entry.sourceActivityKind !== "tool.updated" &&
    entry.sourceActivityKind !== "tool.completed"
  ) {
    return undefined;
  }

  return entry.toolCallId ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}` : undefined;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  // Subagent rows collapse by spawn group, not adjacency: a workflow run (or
  // a turn's batch of direct spawns) is ONE narrative event in the chat — a
  // CTA row that opens the Agents panel — no matter how many agents it
  // contains or how their progress rows interleave (quiet-timeline
  // guarantee).
  const spawnRowIndex = new Map<string, number>();
  // Batch membership is decided once, at the FIRST row seen for a taskId.
  // Claude background subagents settle between turns, so their completion
  // rows carry fresh synthetic turn ids (or none) — keying each row by its
  // own turn splintered one batch into a stream of "Kicked off N subagents"
  // rows (live-test finding, thread 7ac7ef05).
  const groupKeyByTaskId = new Map<string, string>();
  const toolLifecycleRowIndex = new Map<string, number>();

  for (const entry of entries) {
    const isTaskRow =
      entry.taskId !== undefined &&
      !entry.isBackgroundTask &&
      (entry.sourceActivityKind === "task.started" ||
        entry.sourceActivityKind === "task.progress" ||
        entry.sourceActivityKind === "task.completed");

    if (isTaskRow && entry.taskId !== undefined) {
      const rememberedKey = groupKeyByTaskId.get(entry.taskId);
      const groupKey = rememberedKey ?? agentSpawnGroupKey(entry);

      if (rememberedKey === undefined) {
        groupKeyByTaskId.set(entry.taskId, groupKey);
      }

      const workflowId = groupKey.startsWith("wf:") ? groupKey.slice(3) : null;
      const existingIndex = spawnRowIndex.get(groupKey);

      if (existingIndex !== undefined) {
        const existing = collapsed[existingIndex]!;

        const agentTaskIds = existing.agentSpawn?.agentTaskIds.includes(entry.taskId)
          ? existing.agentSpawn.agentTaskIds
          : [...(existing.agentSpawn?.agentTaskIds ?? []), entry.taskId];

        collapsed[existingIndex] = {
          ...mergeDerivedWorkLogEntries(existing, entry),
          // The CTA row keeps the group's ANCHOR identity, not the last
          // agent's: id/createdAt/turnId stay pinned to the spawn point so
          // the row renders where the run launched instead of drifting to
          // the newest progress tick (mid-run it drifted below the whole
          // conversation, reading as "no visualization"), and the stable id
          // keeps React state/virtualization sane.
          id: existing.id,
          createdAt: existing.createdAt,
          turnId: existing.turnId ?? null,
          ...(existing.taskId !== undefined ? { taskId: existing.taskId } : {}),
          label: existing.label,
          agentSpawn: { workflowId, agentTaskIds },
        };
        continue;
      }

      spawnRowIndex.set(groupKey, collapsed.length);
      collapsed.push({
        ...entry,
        agentSpawn: { workflowId, agentTaskIds: [entry.taskId] },
      });
      continue;
    }

    const lifecycleKey = toolLifecycleCollapseMapKey(entry);

    if (lifecycleKey !== undefined) {
      const matchingLifecycleIndex = toolLifecycleRowIndex.get(lifecycleKey);

      const matchingEntry =
        matchingLifecycleIndex === undefined ? undefined : collapsed[matchingLifecycleIndex];

      if (
        matchingLifecycleIndex !== undefined &&
        matchingEntry &&
        shouldCollapseToolLifecycleEntries(matchingEntry, entry)
      ) {
        collapsed[matchingLifecycleIndex] = mergeDerivedWorkLogEntries(matchingEntry, entry);
        continue;
      }

      toolLifecycleRowIndex.delete(lifecycleKey);
    }

    const previous = collapsed.at(-1);

    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      const previousIndex = collapsed.length - 1;
      const previousKey = toolLifecycleCollapseMapKey(previous);

      if (previousKey !== undefined) toolLifecycleRowIndex.delete(previousKey);
      const merged = mergeDerivedWorkLogEntries(previous, entry);
      collapsed[previousIndex] = merged;
      const mergedKey = toolLifecycleCollapseMapKey(merged);

      if (mergedKey !== undefined) toolLifecycleRowIndex.set(mergedKey, previousIndex);
      continue;
    }

    collapsed.push(entry);

    if (lifecycleKey !== undefined) {
      toolLifecycleRowIndex.set(lifecycleKey, collapsed.length - 1);
    }
  }

  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (
    previous.sourceActivityKind !== "tool.updated" &&
    previous.sourceActivityKind !== "tool.completed"
  ) {
    return false;
  }

  if (next.sourceActivityKind !== "tool.updated" && next.sourceActivityKind !== "tool.completed") {
    return false;
  }

  if (previous.turnId !== next.turnId) {
    return false;
  }

  if (previous.sourceActivityKind === "tool.completed") {
    return false;
  }

  if (
    previous[workLogCollapseKey] !== undefined &&
    previous[workLogCollapseKey] === next[workLogCollapseKey]
  ) {
    return true;
  }

  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  );
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
  const collapseKey = next[workLogCollapseKey] ?? previous[workLogCollapseKey];
  const toolCallId = next.toolCallId ?? previous.toolCallId;
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
    ...(collapseKey ? { [workLogCollapseKey]: collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolLifecycleStatus !== undefined ? { toolLifecycleStatus } : {}),
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
  // Subagent lifecycle rows collapse by agent identity: one row per agent,
  // progress ticks fold into it, the terminal row wins the label.
  if (
    entry.taskId &&
    (entry.sourceActivityKind === "task.progress" || entry.sourceActivityKind === "task.completed")
  ) {
    return `task${entry.taskId}`;
  }

  if (
    entry.sourceActivityKind !== "tool.updated" &&
    entry.sourceActivityKind !== "tool.completed"
  ) {
    return undefined;
  }

  if (entry.toolCallId) {
    return `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}`;
  }

  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";

  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }

  return [itemType, normalizedLabel, detail].join("\u001f");
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);

  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);

  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
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
