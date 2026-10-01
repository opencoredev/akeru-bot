import { ProviderItemId, TurnId } from "@akeru/contracts";
import * as CodexRpc from "effect-codex-app-server/rpc";

export type CodexServerNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

export function makeCodexServerNotification<M extends CodexRpc.ServerNotificationMethod>(
  method: M,
  params: CodexRpc.ServerNotificationParamsByMethod[M],
): CodexServerNotification {
  return { method, params } as CodexServerNotification;
}

export function readNotificationThreadId(
  notification: CodexServerNotification,
): string | undefined {
  switch (notification.method) {
    case "thread/started":
      return notification.params.thread.id;
    case "error":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "turn/started":
    case "hook/started":
    case "turn/completed":
    case "hook/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/completed":
    case "rawResponseItem/completed":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "serverRequest/resolved":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "thread/compacted":
    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return notification.params.threadId;
    default:
      return undefined;
  }
}

export function makeMemoryConsolidationNotificationFilter(): (
  notification: CodexServerNotification,
) => boolean {
  const threadIds = new Set<string>();

  return (notification) => {
    if (notification.method === "thread/started") {
      const thread = notification.params.thread;
      const source = thread.source;

      if (
        thread.threadSource === "memory_consolidation" ||
        (typeof source === "object" &&
          source !== null &&
          "subAgent" in source &&
          source.subAgent === "memory_consolidation")
      ) {
        threadIds.add(thread.id);

        return true;
      }
    }

    const params = notification.params;

    const threadId =
      notification.method === "thread/started"
        ? notification.params.thread.id
        : "threadId" in params && typeof params.threadId === "string"
          ? params.threadId
          : undefined;

    if (!threadId || !threadIds.has(threadId)) {
      return false;
    }

    if (notification.method === "serverRequest/resolved") {
      return false;
    }

    if (notification.method === "thread/closed") {
      threadIds.delete(threadId);
    }

    return true;
  };
}

export function readRouteFields(notification: CodexServerNotification): {
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
} {
  switch (notification.method) {
    case "thread/started":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "turn/started":
    case "turn/completed":
      return {
        turnId: TurnId.make(notification.params.turn.id),
        itemId: undefined,
      };
    case "error":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "turn/diff/updated":
    case "turn/plan/updated":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "serverRequest/resolved":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "item/started":
    case "item/completed":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.item.id),
      };
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.itemId),
      };
    default:
      return {
        turnId: undefined,
        itemId: undefined,
      };
  }
}

/**
 * Native collab child-agent tracking (multi-agent v2). Under v2 subagents are
 * full app-server threads: identity arrives on `thread/started` with
 * source.subAgent.thread_spawn, lifecycle on `subAgentActivity` items and the
 * child thread's own turn/status/tokenUsage notifications. The runtime
 * registers children from those explicit signals, intercepts their
 * notifications before parent-timeline mapping, and re-emits them as
 * synthetic `collabAgent/*` provider events the adapter turns into task.*
 * runtime events (timelineBypass keeps them out of the parent chat).
 *
 * WIP, probe-gated: registration is deliberately explicit-signals-only. The
 * spec's "provisionally treat unknown foreign thread ids as v2 children" rule
 * needs a live wire capture of the packaged binary before it lands — blind
 * capture risks eating unrelated traffic. Until then a child whose first
 * notification precedes registration passes through as today (no regression
 * vs main, which passes everything through).
 */
export interface CollabChildAgentState {
  readonly agentThreadId: string;
  readonly nickname: string | undefined;
  readonly role: string | undefined;
  readonly agentPath: string | undefined;
  readonly depth: number | undefined;
  readonly parentThreadId: string | undefined;
  /**
   * Parent canonical turn active when the child registered. Stamped on every
   * synthetic collabAgent/* event so clients can batch a fleet by its spawn
   * turn — without it, separate fleets in one thread collapsed into a single
   * "direct:no-turn" CTA (review finding).
   */
  readonly spawnTurnId: TurnId | undefined;
}

export function readThreadSpawnSource(thread: { readonly source: unknown }):
  | {
      nickname: string | undefined;
      role: string | undefined;
      agentPath: string | undefined;
      depth: number | undefined;
      parentThreadId: string | undefined;
    }
  | undefined {
  const source = thread.source;

  if (typeof source !== "object" || source === null || !("subAgent" in source)) {
    return undefined;
  }

  const subAgent = (source as { subAgent: unknown }).subAgent;

  if (typeof subAgent !== "object" || subAgent === null || !("thread_spawn" in subAgent)) {
    return undefined;
  }

  const spawn = (subAgent as { thread_spawn: unknown }).thread_spawn;

  if (typeof spawn !== "object" || spawn === null) {
    return undefined;
  }

  const record = spawn as Record<string, unknown>;

  return {
    nickname: typeof record.agent_nickname === "string" ? record.agent_nickname : undefined,
    role: typeof record.agent_role === "string" ? record.agent_role : undefined,
    agentPath: typeof record.agent_path === "string" ? record.agent_path : undefined,
    depth: typeof record.depth === "number" ? record.depth : undefined,
    parentThreadId:
      typeof record.parent_thread_id === "string" ? record.parent_thread_id : undefined,
  };
}

export function rememberCollabReceiverTurns(
  collabReceiverTurns: Map<string, TurnId>,
  notification: CodexServerNotification,
  parentTurnId: TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }

  if (notification.params.item.type !== "collabAgentToolCall") {
    return;
  }

  for (const receiverThreadId of notification.params.item.receiverThreadIds) {
    collabReceiverTurns.set(receiverThreadId, parentTurnId);
  }
}

export function shouldSuppressChildConversationNotification(
  method: CodexRpc.ServerNotificationMethod,
): boolean {
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta"
  );
}

/**
 * How a notification addressed to a REGISTERED child thread is handled.
 *
 * Exported and pure so the routing table can be asserted against captured
 * wire traces (see codexMultiAgentWire.json) rather than only read.
 *
 * - "agent-event": map to a synthetic collabAgent/* event (Agents surface).
 * - "parent": pass through to the parent path — it carries state the parent
 *   still owns (approval correlation cleanup).
 * - "drop": genuine child chatter with no parent meaning (deltas, name and
 *   plan updates).
 *
 * Default is "drop" ONLY for the enumerated chatter; anything unrecognized
 * routes to "parent" so new wire methods surface instead of vanishing
 * (two shipped bugs came from a catch-all that swallowed everything).
 */
export type CodexChildNotificationRoute = "agent-event" | "parent" | "drop";

export const CHILD_AGENT_EVENT_METHODS: ReadonlySet<string> = new Set([
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "item/started",
  "item/completed",
  "thread/closed",
  "error",
]);

export const CHILD_CHATTER_METHODS: ReadonlySet<string> = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/plan/delta",
  "turn/plan/updated",
  "turn/diff/updated",
  "thread/name/updated",
  "thread/settings/updated",
  "rawResponseItem/completed",
  // Child-owned thread lifecycle: the parent adapter maps these onto the
  // PARENT thread (archived/compacted state), so a child compacting would
  // rewrite the parent. Mirrors the v1 suppressor list — dropping them is
  // the pre-existing behavior for collab children (review finding).
  "thread/archived",
  "thread/unarchived",
  "thread/compacted",
  // Registration path 1 handles a child's first thread/started; a repeat
  // must not reach the parent (it would restart the parent's thread state).
  "thread/started",
]);

export function routeCodexChildNotification(method: string): CodexChildNotificationRoute {
  if (CHILD_AGENT_EVENT_METHODS.has(method)) {
    return "agent-event";
  }

  if (CHILD_CHATTER_METHODS.has(method)) {
    return "drop";
  }

  // Unknown or parent-owned (serverRequest/resolved, approvals, …).
  return "parent";
}
