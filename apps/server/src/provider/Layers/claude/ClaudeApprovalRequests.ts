import { type PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  PROVIDER_APPROVAL_ARGUMENT_MAX_CHARS,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { type ProviderAdapterRequestError } from "../../Errors.ts";
import type { SdkRecord } from "../ProtocolJson.ts";
import { PROVIDER, type ClaudeSessionContext, type PendingApproval } from "./ClaudeAdapterState.ts";
import {
  asCanonicalTurnId,
  asRuntimeRequestId,
  classifyRequestType,
  nativeProviderRefs,
} from "./ClaudeProtocolValues.ts";

export interface ClaudeToolApprovalRequest {
  readonly toolName: string;
  readonly toolInput: SdkRecord;
  readonly toolUseID: string | undefined;
  readonly signal: AbortSignal;
  readonly suggestions?: ReadonlyArray<PermissionUpdate> | undefined;
  /** Why the owner is asked, shown under the exact action. */
  readonly reason?: string;
  /** Limits the answers the client offers. */
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly rawMethod: string;
}

/**
 * Opens one approval request in the chat and waits for the answer that
 * `respondToRequest` delivers. An aborted call resolves as `cancel`.
 */
export function createClaudeApprovalRequests(deps: {
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly runFork: ReturnType<typeof Effect.runForkWith<never>>;
  readonly randomUUIDv4: Effect.Effect<string, ProviderAdapterRequestError, never>;
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError,
    never
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}) {
  const { pendingApprovals, runFork } = deps;

  const awaitToolApproval = Effect.fn("awaitToolApproval")(function* (
    context: ClaudeSessionContext,
    request: ClaudeToolApprovalRequest,
  ) {
    const requestId = ApprovalRequestId.make(yield* deps.randomUUIDv4);
    const requestType = classifyRequestType(request.toolName);

    // The card shows the exact command, path, or full input, then why the policy asks.
    const detail = [claudeApprovalDetail(request.toolName, request.toolInput), request.reason]
      .filter(Predicate.isString)
      .join("\n\n");

    const args = claudeApprovalArgs(request.toolName, request.toolInput, request.reason);

    const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();

    const pendingApproval: PendingApproval = {
      requestType,
      detail,
      decision: decisionDeferred,
      ...(request.suggestions ? { suggestions: request.suggestions } : {}),
    };

    const currentTurn = () =>
      context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {};

    const requestedStamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "request.opened",
      eventId: requestedStamp.eventId,
      provider: PROVIDER,
      createdAt: requestedStamp.createdAt,
      threadId: context.session.threadId,
      ...currentTurn(),
      requestId: asRuntimeRequestId(requestId),
      payload: {
        requestType,
        detail,
        toolName: request.toolName,
        ...(args ? { args } : {}),
        ...(request.options ? { options: request.options } : {}),
      },
      providerRefs: nativeProviderRefs(context, { providerItemId: request.toolUseID }),
      raw: {
        source: "claude.sdk.permission",
        method: `${request.rawMethod}/request`,
        payload: { toolName: request.toolName, input: request.toolInput },
      },
    });

    pendingApprovals.set(requestId, pendingApproval);

    const onAbort = () => {
      if (!pendingApprovals.has(requestId)) {
        return;
      }

      pendingApprovals.delete(requestId);
      runFork(Deferred.succeed(decisionDeferred, "cancel"));
    };

    request.signal.addEventListener("abort", onAbort, { once: true });

    // The signal may have aborted while the request event emissions were
    // awaited, before the listener existed.
    if (request.signal.aborted) {
      onAbort();
    }

    const decision = yield* Deferred.await(decisionDeferred);
    pendingApprovals.delete(requestId);

    const resolvedStamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "request.resolved",
      eventId: resolvedStamp.eventId,
      provider: PROVIDER,
      createdAt: resolvedStamp.createdAt,
      threadId: context.session.threadId,
      ...currentTurn(),
      requestId: asRuntimeRequestId(requestId),
      payload: { requestType, decision },
      providerRefs: nativeProviderRefs(context, { providerItemId: request.toolUseID }),
      raw: {
        source: "claude.sdk.permission",
        method: `${request.rawMethod}/decision`,
        payload: { decision },
      },
    });

    return decision;
  });

  return { awaitToolApproval };
}

/** Key arguments a person needs to judge a call: what runs, or which file. */
const ACTION_KEYS = ["command", "file_path", "notebook_path", "path", "url", "pattern"] as const;

/** The exact command or target of a call, when it has one. */
export function claudeApprovalAction(toolName: string, input: SdkRecord): string | undefined {
  for (const key of ACTION_KEYS) {
    const value = input[key];

    if (Predicate.isString(value) && value.trim().length > 0) {
      return key === "command" ? value : `${toolName}: ${value}`;
    }
  }

  return undefined;
}

/**
 * The arguments the approval card shows, plus the policy reason. A call whose
 * detail is its whole input carries no command or path here, so no client
 * shows one argument in place of the rest.
 */
export function claudeApprovalArgs(
  toolName: string,
  input: SdkRecord,
  reason: string | undefined,
): Record<string, string> | undefined {
  const keys: ReadonlyArray<(typeof ACTION_KEYS)[number]> = showsFullInput(toolName, input)
    ? []
    : ACTION_KEYS;

  const entries = keys.flatMap((key) => {
    const value = input[key];

    return Predicate.isString(value) && value.length > 0 ? [[key, value] as const] : [];
  });

  if (entries.length === 0 && !reason) return undefined;

  return Object.fromEntries([...entries, ...(reason ? [["reason", reason] as const] : [])]);
}

/**
 * True when one command or path does not describe the call, so the card
 * shows its whole input. MCP tools always qualify: their other arguments,
 * such as a message body, matter as much as any path.
 */
function showsFullInput(toolName: string, input: SdkRecord): boolean {
  return toolName.startsWith("mcp__") || claudeApprovalAction(toolName, input) === undefined;
}

/**
 * What the approval card shows for a call: its exact command or path, or its
 * whole input as indented JSON. The input is never cut; a call too long to
 * show is declined instead.
 */
export function claudeApprovalDetail(toolName: string, input: SdkRecord): string {
  const action = claudeApprovalAction(toolName, input);

  return action === undefined || showsFullInput(toolName, input)
    ? `${toolName}\n${JSON.stringify(input, null, 2)}`
    : action;
}

/**
 * True when a command, path, or whole input is too long for an approval card
 * to show in full. Such a call is declined rather than approved from a
 * partial view.
 */
export function claudeApprovalTooLong(toolName: string, input: SdkRecord): boolean {
  if (
    showsFullInput(toolName, input) &&
    claudeApprovalDetail(toolName, input).length > PROVIDER_APPROVAL_ARGUMENT_MAX_CHARS
  ) {
    return true;
  }

  return ACTION_KEYS.some((key) => {
    const value = input[key];

    return Predicate.isString(value) && value.length > PROVIDER_APPROVAL_ARGUMENT_MAX_CHARS;
  });
}

export const CLAUDE_APPROVAL_TOO_LONG_MESSAGE = `This command, path, or tool input is longer than ${PROVIDER_APPROVAL_ARGUMENT_MAX_CHARS} characters, too long to show in full for approval, so Akeru declined it. Split it into shorter steps.`;
