// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Mastra-side twin of `TestProviderAdapter.integration.ts`.
 *
 * `AgentController` routes Mastra-backed drivers (codex, claudeAgent, grok,
 * kimi, opencodeGo) through the Mastra harness instead of the legacy adapter
 * bridge. Integration tests that only fake the adapter would otherwise boot
 * the real Mastra stack and attempt live model calls. This stub plays the
 * same `TestTurnResponse` fixtures through the controller's Session seam
 * (`sendMessage`, `subscribe`, approval and abort hooks) so the full
 * orchestration pipeline still runs deterministically.
 */
import type { AgentControllerEvent, MastraDBMessage, Session } from "@mastra/core/agent-controller";
import {
  ApprovalRequestId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";

import type { AgentControllerLiveOptions } from "../src/provider/Layers/AgentController.ts";
import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";

export interface TestMastraHarness {
  readonly factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]>;
  readonly queueTurnResponseForNextSession: (response: TestTurnResponse) => void;
  readonly queueTurnResponse: (threadId: ThreadId, response: TestTurnResponse) => void;
  readonly hasSession: (threadId: ThreadId) => boolean;
  readonly getStartCount: () => number;
  readonly listActiveSessionIds: () => ReadonlyArray<ThreadId>;
  readonly getInterruptCalls: (threadId: ThreadId) => ReadonlyArray<TurnId | undefined>;
  /** Mastra model ids the thread's sessions switched to, oldest first. */
  readonly getModelSwitches: (threadId: ThreadId) => ReadonlyArray<string>;
  readonly getApprovalResponses: (threadId: ThreadId) => ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly decision: ProviderApprovalDecision;
  }>;
}

interface SessionState {
  readonly threadId: ThreadId;
  cwd: string | undefined;
  stateSnapshot: Record<string, unknown>;
  readonly queuedResponses: Array<TestTurnResponse>;
  readonly listeners: Set<(event: AgentControllerEvent) => void>;
  readonly interruptCalls: Array<TurnId | undefined>;
  readonly modelSwitches: Array<string>;
  readonly approvalResponses: Array<{
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly decision: ProviderApprovalDecision;
  }>;
  turnCount: number;
  /** The turn id currently in flight, so aborts record the right turn. */
  activeTurnId: TurnId | undefined;
  readonly pendingApprovalToolCallIds: Array<string>;
  /** Settles the in-flight `sendMessage`; the abort path wins over the fixture. */
  finishActiveTurn: (() => void) | undefined;
  assistantMessageIndex: number;
  assistantText: string;
  /** Released when the user answers a pending tool approval. */
  resolvePendingApproval: (() => void) | undefined;
}

const DECISION_BY_RESPONSE: Record<string, ProviderApprovalDecision> = {
  approve: "accept",
  decline: "decline",
};

function assistantMessage(threadId: ThreadId, index: number, text: string): MastraDBMessage {
  return {
    id: `assistant-${index}`,
    role: "assistant",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    content: {
      format: 2,
      parts: [{ type: "text", text }],
    },
    threadId: String(threadId),
    resourceId: String(threadId),
  } as MastraDBMessage;
}

function payloadString(raw: Record<string, unknown>, key: string): string | undefined {
  const direct = raw[key];
  if (typeof direct === "string") return direct;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const nested = payload?.[key];
  return typeof nested === "string" ? nested : undefined;
}

export function makeTestMastraHarness(): TestMastraHarness {
  const sessions = new Map<string, SessionState>();
  // Outlives session restarts so a model change that restarts the session stays visible.
  const modelSwitchesByThread = new Map<string, Array<string>>();
  const queuedResponsesForNextSession: TestTurnResponse[] = [];
  let sessionStartCount = 0;
  let toolCallCount = 0;

  const nextToolCallId = () => {
    toolCallCount += 1;
    return `tool-call-${toolCallCount}`;
  };

  const publish = (state: SessionState, event: AgentControllerEvent) => {
    for (const listener of [...state.listeners]) listener(event);
  };

  // Translates legacy adapter fixture events into the Mastra controller events
  // AgentController consumes. Events without a Mastra equivalent are dropped.
  const emitFixtureEvent = (state: SessionState, raw: Record<string, unknown>) => {
    switch (raw.type) {
      case "message.delta":
      case "content.delta":
        state.assistantText += payloadString(raw, "delta") ?? "";
        return;
      case "tool.started":
      case "item.started": {
        const toolCallId = nextToolCallId();
        const detail = typeof raw.detail === "string" ? raw.detail : undefined;
        publish(state, {
          type: "tool_start",
          toolCallId,
          toolName: typeof raw.title === "string" ? raw.title : "tool",
          args: detail ? { path: detail } : {},
        });
        publish(state, { type: "tool_end", toolCallId, result: {}, isError: false });
        return;
      }
      case "approval.requested":
      case "request.opened": {
        const toolCallId = typeof raw.requestId === "string" ? raw.requestId : nextToolCallId();
        state.pendingApprovalToolCallIds.push(toolCallId);
        publish(state, {
          type: "tool_approval_required",
          toolCallId,
          // A non-builtin tool name keeps the request out of the controller's
          // auto-approve path so a real pending approval reaches ingestion.
          toolName: "custom_test_command",
          args: {},
        });
        return;
      }
      case "runtime.error":
        publish(state, {
          type: "error",
          error: new Error(payloadString(raw, "message") ?? "runtime error"),
        });
        return;
      case "turn.completed": {
        const status = payloadString(raw, "status") ?? payloadString(raw, "state") ?? "completed";
        publish(state, {
          type: "agent_end",
          reason:
            status === "failed"
              ? "error"
              : status === "interrupted" || status === "cancelled"
                ? "aborted"
                : "complete",
        });
        return;
      }
      default:
        return;
    }
  };

  const runTurn = async (state: SessionState, response: TestTurnResponse) => {
    const terminal = response.events.filter(
      (event) => event.type === "turn.completed" || event.type === "turn.aborted",
    );
    for (const raw of response.events) {
      if (raw.type === "turn.completed" || raw.type === "turn.aborted") continue;
      emitFixtureEvent(state, raw);
    }
    while (state.pendingApprovalToolCallIds.length > 0) {
      await new Promise<void>((resolve) => {
        state.resolvePendingApproval = resolve;
      });
    }
    if (response.mutateWorkspace && state.cwd) {
      await Effect.runPromise(
        response.mutateWorkspace({ cwd: state.cwd, turnCount: state.turnCount }),
      );
    }
    // Flush accumulated text as one completed message so the controller
    // publishes the assistant item before the terminal state.
    if (state.assistantText) {
      state.assistantMessageIndex += 1;
      const message = assistantMessage(
        state.threadId,
        state.assistantMessageIndex,
        state.assistantText,
      );
      state.assistantText = "";
      publish(state, { type: "message_end", message });
    }
    if (terminal.length === 0) {
      publish(state, { type: "agent_end", reason: "complete" });
      return;
    }
    for (const raw of terminal) emitFixtureEvent(state, raw);
  };

  const makeSession = (state: SessionState) =>
    ({
      state: {
        get: () => state.stateSnapshot,
        set: async (next: Record<string, unknown>) => {
          state.stateSnapshot = next;
          if (typeof next.projectPath === "string") state.cwd = next.projectPath;
        },
      },
      mode: { get: () => "build", switch: async () => undefined },
      model: {
        get: () => state.modelSwitches.at(-1) ?? "default",
        switch: async ({ modelId }: { readonly modelId: string }) => {
          state.modelSwitches.push(modelId);
        },
      },
      permissions: {
        setForCategory: async () => undefined,
        setForTool: async () => undefined,
      },
      grantTool: () => undefined,
      subscribe: (listener: (event: AgentControllerEvent) => void) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      sendMessage: () => {
        state.turnCount += 1;
        state.activeTurnId = TurnId.make(`turn-${state.turnCount}`);
        const response = state.queuedResponses.shift() ?? { events: [] };
        return new Promise<void>((resolve) => {
          state.finishActiveTurn = resolve;
          void runTurn(state, response).then(resolve);
        });
      },
      abort: () => {
        state.interruptCalls.push(state.activeTurnId);
        state.activeTurnId = undefined;
        state.finishActiveTurn?.();
        state.finishActiveTurn = undefined;
        state.pendingApprovalToolCallIds.length = 0;
        state.resolvePendingApproval?.();
        state.resolvePendingApproval = undefined;
      },
      respondToToolApproval: ({
        toolCallId,
        decision,
      }: {
        readonly toolCallId: string;
        readonly decision: string;
      }) => {
        state.approvalResponses.push({
          threadId: state.threadId,
          requestId: ApprovalRequestId.make(toolCallId),
          decision: DECISION_BY_RESPONSE[decision] ?? "decline",
        });
        const index = state.pendingApprovalToolCallIds.indexOf(toolCallId);
        if (index >= 0) state.pendingApprovalToolCallIds.splice(index, 1);
        const resolve = state.resolvePendingApproval;
        state.resolvePendingApproval = undefined;
        resolve?.();
      },
      respondToToolSuspension: async () => undefined,
    }) as unknown as Session<Record<string, unknown>>;

  const factory: TestMastraHarness["factory"] = () =>
    Effect.succeed({
      controller: {
        init: async () => undefined,
        createSession: async (input: {
          readonly resourceId?: string;
          readonly threadId?: string;
          readonly tags?: { readonly projectPath?: string };
        }) => {
          const threadId = ThreadId.make(String(input.resourceId ?? input.threadId));
          const state: SessionState = {
            threadId,
            cwd: input.tags?.projectPath,
            stateSnapshot: {},
            queuedResponses: queuedResponsesForNextSession.splice(0),
            listeners: new Set(),
            interruptCalls: [],
            modelSwitches: modelSwitchesByThread.get(String(threadId)) ?? [],
            approvalResponses: [],
            turnCount: 0,
            activeTurnId: undefined,
            pendingApprovalToolCallIds: [],
            finishActiveTurn: undefined,
            assistantMessageIndex: 0,
            assistantText: "",
            resolvePendingApproval: undefined,
          };
          modelSwitchesByThread.set(String(threadId), state.modelSwitches);
          sessionStartCount += 1;
          sessions.set(String(threadId), state);
          return makeSession(state);
        },
        deleteSession: async ({ resourceId }: { readonly resourceId?: string }) =>
          sessions.delete(String(resourceId)),
      },
    } as never);

  return {
    factory,
    queueTurnResponseForNextSession: (response) => {
      queuedResponsesForNextSession.push(response);
    },
    queueTurnResponse: (threadId, response) => {
      sessions.get(String(threadId))?.queuedResponses.push(response);
    },
    hasSession: (threadId) => sessions.has(String(threadId)),
    getStartCount: () => sessionStartCount,
    listActiveSessionIds: () => Array.from(sessions.values(), (state) => state.threadId),
    getInterruptCalls: (threadId) => [...(sessions.get(String(threadId))?.interruptCalls ?? [])],
    getModelSwitches: (threadId) => [...(modelSwitchesByThread.get(String(threadId)) ?? [])],
    getApprovalResponses: (threadId) => [
      ...(sessions.get(String(threadId))?.approvalResponses ?? []),
    ],
  };
}
