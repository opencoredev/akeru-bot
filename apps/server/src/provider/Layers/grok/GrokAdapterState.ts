import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  type ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as EffectAcpSchema from "effect-acp/schema";
import type * as AcpSessionRuntime from "../../acp/AcpSessionRuntime.ts";

export const PROVIDER = ProviderDriverKind.make("grok");

export const GROK_RESUME_VERSION = 1 as const;

export interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

export type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

export interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

export interface GrokSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * cancels the in-flight prompt and continues the same turn. The current
   * epoch owns the terminal state; a superseded prompt may only flush that
   * stored result when it is last to drain. */
  promptsInFlight: number;
  /** Monotonic id assigned to each sendTurn. Steers discard older epochs. */
  promptEpoch: number;
  /** Prompt epochs below this value must not start an ACP session/prompt. */
  discardBeforeEpoch: number;
  /** Current-epoch terminal result, emitted when the last in-flight prompt drains. */
  pendingTurnCompletion: GrokTurnTerminal | undefined;
  /** Serializes cancel-then-prompt so a steer cannot miss or hit the wrong RPC. */
  readonly promptLifecycle: Semaphore.Semaphore;
  currentModelId: string | undefined;
  stopped: boolean;
}

export type GrokTurnTerminal = {
  readonly errorMessage?: string;
  readonly completedStopReason?: EffectAcpSchema.StopReason | null;
};
