import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import { promptResponseHasMissingXAiStopReason } from "../../acp/XAiAcpExtension.ts";

import {
  GROK_RESUME_VERSION,
  type PendingApproval,
  type PendingUserInput,
  type GrokSessionContext,
  type GrokTurnTerminal,
} from "./GrokAdapterState.ts";

export const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(
  Schema.fromJsonString(Schema.Unknown),
);

export function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);

  return Exit.isSuccess(result) ? result.value : undefined;
}

export function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

export function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

export function appendPromptResultToTurn(
  ctx: GrokSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const resolveNotificationTurnId = (ctx: GrokSessionContext): TurnId | undefined =>
  ctx.activeTurnId;

export const resolveCallbackTurnId = (ctx: GrokSessionContext): TurnId | undefined =>
  ctx.activeTurnId;

export const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, GrokSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);

  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

export function parseGrokResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;

  if (raw.schemaVersion !== GROK_RESUME_VERSION) return undefined;

  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;

  return { sessionId: raw.sessionId.trim() };
}

export function selectGrokPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const preferredKind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";

  const preferred = request.options.find((entry) => entry.kind === preferredKind);
  const preferredId = preferred?.optionId.trim();

  if (preferredId) {
    return preferredId;
  }

  // Grok 4.6 often omits allow_always. The UI still offers "Always allow this session".
  if (decision === "acceptForSession") {
    const once = request.options.find((entry) => entry.kind === "allow_once");
    const onceId = once?.optionId.trim();

    if (onceId) {
      return onceId;
    }
  }

  return undefined;
}

export function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectGrokPermissionOptionId(request, "acceptForSession") ??
    selectGrokPermissionOptionId(request, "accept")
  );
}

export function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null {
  if (response === undefined || promptResponseHasMissingXAiStopReason(response)) {
    return null;
  }

  return response.stopReason;
}

export function grokPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

/**
 * Choose the merged turn's terminal result from one prompt settlement.
 * The current epoch (`promptEpoch >= discardBeforeEpoch`) owns the outcome.
 * A superseded prompt never overwrites that result; if it drains last it
 * only flushes the stored current-epoch result.
 */
export function grokTurnCompletionForPromptEpoch(input: {
  readonly promptEpoch: number;
  readonly discardBeforeEpoch: number;
  readonly remainingPrompts: number;
  readonly stored: GrokTurnTerminal | undefined;
  readonly incoming: GrokTurnTerminal | undefined;
  readonly emitTurnCompletion: boolean;
}): {
  readonly stored: GrokTurnTerminal | undefined;
  readonly emit: GrokTurnTerminal | undefined;
} {
  const superseded = input.promptEpoch < input.discardBeforeEpoch;

  const stored =
    !superseded && input.emitTurnCompletion && input.incoming !== undefined
      ? input.incoming
      : input.stored;

  // The final drain may belong to a superseded prompt whose own settlement is
  // suppressed. It must still flush a terminal result stored by the current
  // epoch, or the merged turn remains running forever.
  const emit = input.remainingPrompts === 0 ? stored : undefined;

  return { stored, emit };
}
