import * as Match from "effect/Match";
import { readSdkRecord } from "../ProtocolJson.ts";
import { isSdkRecord } from "../ProtocolJson.ts";
import type { SdkRecord } from "../ProtocolJson.ts";
import * as Predicate from "effect/Predicate";
import { type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type RuntimeTaskStatus,
  type RuntimeTaskUsage,
  type TaskAgentLinkage,
} from "@akeru/contracts";

import {
  type ToolInFlight,
  type ClaudeTaskState,
  type ClaudeTaskAgentState,
  type PlanStep,
} from "./ClaudeAdapterState.ts";

/**
 * How many racing snapshot models to buffer per session. A snapshot whose
 * task_started never arrives would otherwise pin its entry for the session's
 * lifetime; oldest entries evict first.
 */
export const PENDING_TASK_MODEL_CAP = 64;

/**
 * Buffers a subagent snapshot's authoritative model under its
 * parent_tool_use_id, for snapshots that beat their task_started to the
 * stream. task_started consumes the entry when it registers the task.
 */
export function rememberPendingTaskModel(
  pending: Map<string, string>,
  parentToolUseId: string,
  model: string,
): void {
  pending.set(parentToolUseId, model);

  if (pending.size > PENDING_TASK_MODEL_CAP) {
    const oldest = pending.keys().next();

    if (!oldest.done) {
      pending.delete(oldest.value);
    }
  }
}

export function isTodoTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("todowrite");
}

export function extractPlanStepsFromTodoInput(input: SdkRecord): PlanStep[] | null {
  // TodoWrite format: { todos: [{ content, status, activeForm? }] }
  const todos = input.todos;

  if (!Array.isArray(todos) || todos.length === 0) {
    return null;
  }

  return todos
    .filter((t): t is SdkRecord => t !== null && isSdkRecord(t))
    .map((todo) => ({
      step:
        Predicate.isString(todo.content) && todo.content.trim().length > 0
          ? todo.content.trim()
          : "Task",
      status: Match.value(todo.status).pipe(
        Match.when("completed", () => "completed" as const),
        Match.when("in_progress", () => "inProgress" as const),
        Match.orElse(() => "pending" as const),
      ),
    }));
}

export function isClaudeTaskTool(toolName: string): boolean {
  return toolName === "TaskCreate" || toolName === "TaskUpdate" || toolName === "TaskList";
}

const matchClaudeTaskStatus = Match.type<string | undefined>().pipe(
  Match.when("completed", () => "completed" as const),
  Match.when("in_progress", () => "inProgress" as const),
  Match.orElse(() => "pending" as const),
);

export function normalizeClaudeTaskStatus<Input>(value: Input): PlanStep["status"] {
  return matchClaudeTaskStatus(Predicate.isString(value) ? value : undefined);
}

export function readString<Input0>(valueInput: Input0): string | undefined {
  const value = valueInput;

  return Predicate.isString(value) && value.trim().length > 0 ? value.trim() : undefined;
}

export function readStringArray<Input0>(valueInput: Input0): Array<string> {
  const value = valueInput;

  return Array.isArray(value)
    ? value.filter((entry): entry is string => Predicate.isString(entry) && entry.length > 0)
    : [];
}

export function readClaudeToolUseResult(message: SDKMessage): SdkRecord | undefined {
  if (message.type !== "user") {
    return undefined;
  }

  const result = readSdkRecord(message.tool_use_result);

  return result !== null && isSdkRecord(result) && !Array.isArray(result) ? result : undefined;
}

export function readClaudeTaskFromResult(result: SdkRecord | undefined): SdkRecord | undefined {
  const task = readSdkRecord(result?.task);

  return task !== null && isSdkRecord(task) && !Array.isArray(task) ? task : undefined;
}

export function applyClaudeTaskToolResult(
  tasks: Map<string, ClaudeTaskState>,
  tool: ToolInFlight,
  result: SdkRecord | undefined,
): boolean {
  if (!isClaudeTaskTool(tool.toolName)) {
    return false;
  }

  let changed = false;

  if (tool.toolName === "TaskList") {
    const resultTasks = result?.tasks;

    if (!Array.isArray(resultTasks)) {
      return false;
    }

    tasks.clear();

    for (const entry of resultTasks) {
      if (entry === null || !isSdkRecord(entry) || Array.isArray(entry)) {
        continue;
      }

      const task = entry;
      const id = readString(task.id);
      const subject = readString(task.subject);

      if (!id || !subject) {
        continue;
      }

      tasks.set(id, {
        id,
        subject,
        status: normalizeClaudeTaskStatus(task.status),
        blockedBy: new Set(readStringArray(task.blockedBy)),
      });
    }

    return tasks.size > 0;
  }

  if (tool.toolName === "TaskCreate") {
    const resultTask = readClaudeTaskFromResult(result);
    const id = readString(resultTask?.id);
    const subject = readString(resultTask?.subject) ?? readString(tool.input.subject);

    if (!id || !subject) {
      return false;
    }

    tasks.set(id, {
      id,
      subject,
      status: normalizeClaudeTaskStatus(tool.input.status),
      blockedBy: new Set(readStringArray(tool.input.blockedBy)),
    });

    return true;
  }

  const taskId = readString(tool.input.taskId) ?? readString(result?.taskId);

  if (!taskId) {
    return false;
  }

  const task = tasks.get(taskId);

  if (!task) {
    return false;
  }

  const subject = readString(tool.input.subject);

  if (subject && task.subject !== subject) {
    task.subject = subject;
    changed = true;
  }

  if (Predicate.isString(tool.input.status)) {
    const status = normalizeClaudeTaskStatus(tool.input.status);

    if (task.status !== status) {
      task.status = status;
      changed = true;
    }
  }

  for (const dependency of readStringArray(tool.input.addBlockedBy)) {
    if (!task.blockedBy.has(dependency)) {
      task.blockedBy.add(dependency);
      changed = true;
    }
  }

  for (const dependency of readStringArray(tool.input.removeBlockedBy)) {
    if (task.blockedBy.delete(dependency)) {
      changed = true;
    }
  }

  return changed;
}

export function planStepsFromClaudeTasks(tasks: Map<string, ClaudeTaskState>): PlanStep[] {
  return Array.from(tasks.values()).map((task) => {
    const blockedBy = Array.from(task.blockedBy);
    const blockedSuffix = blockedBy.length > 0 ? ` (blocked by #${blockedBy.join(", #")})` : "";

    return {
      step: `${task.subject}${blockedSuffix}`,
      status: task.status,
    };
  });
}

/** Only http/https survive; anything else (javascript:, file:, …) is dropped. */
export function sanitizeSessionUrl<Input0>(valueInput: Input0): string | undefined {
  const value = valueInput;

  if (!Predicate.isString(value)) {
    return undefined;
  }

  const trimmed = value.trim();

  if (!/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

export function nonNegativeInt<Input0>(valueInput: Input0): number | undefined {
  const value = valueInput;

  return Predicate.isNumber(value) && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function trimmedString<Input0>(valueInput: Input0): string | undefined {
  const value = valueInput;

  if (!Predicate.isString(value)) {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * SDK task usage ({total_tokens, tool_uses, duration_ms}, sometimes with
 * input/output/cache breakdowns) → the typed contract shape. Unknown or
 * malformed input yields undefined rather than a partial guess.
 */
export function normalizeTaskUsage<Input0>(usageInput: Input0): RuntimeTaskUsage | undefined {
  const usage = usageInput;

  if (!isSdkRecord(usage) || usage === null) {
    return undefined;
  }

  const record = usage;
  const totalTokens = nonNegativeInt(record.total_tokens);

  if (totalTokens === undefined) {
    return undefined;
  }

  const inputTokens = nonNegativeInt(record.input_tokens);
  const cachedInputTokens = nonNegativeInt(record.cache_read_input_tokens);
  const outputTokens = nonNegativeInt(record.output_tokens);
  const toolUses = nonNegativeInt(record.tool_uses);
  const durationMs = nonNegativeInt(record.duration_ms);

  return {
    totalTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** SDK task_updated patch status → the shared wire vocabulary. */
export const CLAUDE_TASK_PATCH_STATUS = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  killed: "cancelled",
  paused: "idle",
} satisfies Record<string, RuntimeTaskStatus>;

/**
 * Resolves a stream message's parent_tool_use_id to the owning agent's
 * taskId. The Task tool's tool_use_id is remembered on task_started; any
 * subagent-forwarded block carries that id as its parent. Returns undefined
 * for parent-conversation traffic.
 */
export function agentIdForParentToolUse(
  agents: Map<string, ClaudeTaskAgentState>,
  parentToolUseId: string | null | undefined,
): string | undefined {
  if (parentToolUseId === null || parentToolUseId === undefined) {
    return undefined;
  }

  for (const agent of agents.values()) {
    if (agent.toolUseId === parentToolUseId) {
      return agent.taskId;
    }
  }

  return undefined;
}

/**
 * Linkage bundle repeated on every task.* payload for `taskId`. Reads the
 * remembered identity (from task_started) so progress/terminal rows are
 * self-describing even when the start row ages out of activity retention.
 */
export function taskLinkageFor(
  agents: Map<string, ClaudeTaskAgentState>,
  taskId: string,
): TaskAgentLinkage {
  const agent = agents.get(taskId);

  if (!agent) {
    return {};
  }

  return {
    ...(agent.taskType ? { taskType: agent.taskType } : {}),
    ...(agent.owningAgentId ? { agentId: agent.owningAgentId } : {}),
    ...(agent.description ? { title: agent.description } : {}),
    ...(agent.subagentType ? { role: agent.subagentType } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(agent.toolUseId ? { toolUseId: agent.toolUseId } : {}),
    ...(agent.workflowName ? { workflowName: agent.workflowName } : {}),
    ...(agent.runHandles ? { runHandles: agent.runHandles } : {}),
  };
}

export const WORKFLOW_PHASE_CAP = 64;

export const WORKFLOW_AGENT_CAP = 100;

export interface ClaudeWorkflowAgentEntry {
  readonly index: number;
  readonly state: string;
  readonly label: string | undefined;
  readonly phaseIndex: number | undefined;
  readonly phaseTitle: string | undefined;
  readonly model: string | undefined;
  readonly attempt: number | undefined;
  readonly lastToolName: string | undefined;
  readonly startedAt: string | undefined;
  readonly error: string | undefined;
  readonly tokens: number | undefined;
  readonly toolCalls: number | undefined;
}

export interface ClaudeWorkflowProgress {
  readonly phases: ReadonlyArray<{ index: number; title: string }>;
  readonly agents: ReadonlyArray<ClaudeWorkflowAgentEntry>;
}

/**
 * Defensive parse of the SDK's undeclared-but-real workflow_progress array on
 * task_progress messages (wire-confirmed; absent from sdk.d.ts). Unknown
 * shapes are skipped per-entry; phases and agents dedupe by index before
 * caps; a vanished field never throws. If the array disappears upstream the
 * caller keeps the coordinator row and plain task lifecycle.
 */
export function parseWorkflowProgress<Input0>(
  valueInput: Input0,
): ClaudeWorkflowProgress | undefined {
  const value = valueInput;

  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const phasesByIndex = new Map<number, string>();
  const agentsByIndex = new Map<number, ClaudeWorkflowAgentEntry>();

  for (const entry of value) {
    if (!isSdkRecord(entry) || entry === null) {
      continue;
    }

    const record = entry;
    const entryType = trimmedString(record.type);

    if (entryType === "workflow_phase") {
      const index = nonNegativeInt(record.index);
      const title = trimmedString(record.title);

      if (index !== undefined && title && !phasesByIndex.has(index)) {
        phasesByIndex.set(index, title);
      }

      continue;
    }

    if (entryType !== "workflow_agent") {
      continue;
    }

    const index = nonNegativeInt(record.index);
    const state = trimmedString(record.state);

    if (index === undefined || !state || agentsByIndex.has(index)) {
      continue;
    }

    agentsByIndex.set(index, {
      index,
      state,
      label: trimmedString(record.label),
      phaseIndex: nonNegativeInt(record.phaseIndex),
      phaseTitle: trimmedString(record.phaseTitle),
      model: trimmedString(record.model),
      attempt: nonNegativeInt(record.attempt),
      lastToolName: trimmedString(record.lastToolName),
      startedAt: trimmedString(record.startedAt),
      error: trimmedString(record.error),
      tokens: nonNegativeInt(record.tokens),
      toolCalls: nonNegativeInt(record.toolCalls),
    });
  }

  if (phasesByIndex.size === 0 && agentsByIndex.size === 0) {
    return undefined;
  }

  const phases = Array.from(phasesByIndex.entries())
    .map(([index, title]) => ({ index, title }))
    .toSorted((a, b) => a.index - b.index)
    .slice(0, WORKFLOW_PHASE_CAP);

  const agents = Array.from(agentsByIndex.values())
    .toSorted((a, b) => a.index - b.index)
    .slice(0, WORKFLOW_AGENT_CAP);

  return { phases, agents };
}

/**
 * Workflow member states from workflow_progress → shared task status.
 * Unknown states read running after startedAt, pending before it.
 */
export function workflowAgentStatus(entry: ClaudeWorkflowAgentEntry): RuntimeTaskStatus {
  switch (entry.state) {
    case "queued":
    case "pending":
      return "pending";
    case "start":
    case "running":
      return entry.startedAt === undefined ? "pending" : "running";
    case "done":
      return "completed";
    case "error":
      return "failed";
    default:
      return entry.startedAt === undefined ? "pending" : "running";
  }
}
