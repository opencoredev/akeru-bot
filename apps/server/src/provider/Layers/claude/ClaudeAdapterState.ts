import type { SdkRecord } from "../ProtocolJson.ts";
import {
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionUpdate,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  type TaskRunHandles,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

export type PlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

export const PROVIDER = ProviderDriverKind.make("claudeAgent");

export type ClaudeTextStreamKind = Extract<
  RuntimeContentStreamKind,
  "assistant_text" | "reasoning_text"
>;

export type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

export type ClaudeSdkEffort = NonNullable<ClaudeQueryOptions["effort"]>;

export type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

export interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

export interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  /**
   * True for turns auto-started by assistant output arriving without an
   * active turn (background agent/subagent responses between user prompts).
   * Synthetic turns are auto-closed by the next sendTurn; real turns are
   * steered instead (the queued message continues the same turn).
   */
  readonly synthetic?: boolean;
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  latestAssistantUsage: unknown | undefined;
  compactedSinceLatestAssistantUsage: boolean;
  nextSyntheticAssistantBlockIndex: number;
  authenticationFailureMessage: string | undefined;
  rejectedRateLimitTypes: Set<string>;
  latestAssistantRateLimited: boolean;
}

export function createClaudeTurnState(
  turnId: TurnId,
  startedAt: string,
  extra?: { readonly synthetic?: true },
): ClaudeTurnState {
  return {
    turnId,
    startedAt,
    ...(extra?.synthetic ? { synthetic: true } : {}),
    items: [],
    assistantTextBlocks: new Map(),
    assistantTextBlockOrder: [],
    capturedProposedPlanKeys: new Set(),
    latestAssistantUsage: undefined,
    compactedSinceLatestAssistantUsage: false,
    nextSyntheticAssistantBlockIndex: -1,
    authenticationFailureMessage: undefined,
    rejectedRateLimitTypes: new Set(),
    latestAssistantRateLimited: false,
  };
}

export interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

export interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

export interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  /** Unparks the waiting handler as cancelled. Session teardown must run it. */
  readonly cancel: Effect.Effect<void>;
}

export interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: SdkRecord;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
  /** Owning agent when this tool ran inside a subagent (see attribution note). */
  readonly agentId?: string;
  readonly parentToolUseId?: string;
}

export interface ClaudeTaskState {
  readonly id: string;
  subject: string;
  status: PlanStep["status"];
  readonly blockedBy: Set<string>;
}

/**
 * Agent identity captured from task_started and repeated on every subsequent
 * task.* payload, so client folds can reconstruct an agent even when its
 * start row aged out of activity retention.
 */
export interface ClaudeTaskAgentState {
  readonly taskId: string;
  toolUseId: string | undefined;
  description: string | undefined;
  subagentType: string | undefined;
  taskType: string | undefined;
  workflowName: string | undefined;
  skipTranscript: boolean;
  runHandles: TaskRunHandles | undefined;
  /** Set when this task was launched from inside a subagent. */
  owningAgentId: string | undefined;
  /** Seeded from the launching tool's input; refined by the subagent's own
   * assistant snapshots (authoritative API model). */
  model: string | undefined;
  effort: string | undefined;
}

export interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  currentApiModelId: string | undefined;
  /** Effective effort for the session's turns; subagents without an explicit
   * effort override inherit this. */
  currentEffort: string | undefined;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  readonly claudeTasks: Map<string, ClaudeTaskState>;
  readonly taskAgents: Map<string, ClaudeTaskAgentState>;
  /**
   * Authoritative subagent models from assistant snapshots that arrived before
   * their task_started registered the task, keyed by parent_tool_use_id.
   * Written through `rememberPendingTaskModel`, consumed by task_started.
   */
  readonly pendingTaskModels: Map<string, string>;
  /**
   * Last emitted workflow-member fingerprint per member slot. A coordinator
   * task_progress repeats the FULL member array every tick; without a
   * material-transition filter one provider tick fans out into up to 100
   * runtime events (event-log writes, queue pressure, client reducer work)
   * even when nothing changed for most members.
   */
  readonly workflowMemberFingerprints: Map<string, string>;
  /** Task ids that have started and not yet reached a terminal state. */
  readonly liveTaskIds: Set<string>;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastKnownTotalProcessedTokens: number | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  announcedUsageLimits: { turnId: string; keys: Set<string> } | undefined;
  stopped: boolean;
}

export interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly close: () => void;
}
