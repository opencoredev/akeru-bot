import * as Predicate from "effect/Predicate";
import type { ProviderApprovalDecision } from "@akeru/contracts";
import { ProviderDriverKind } from "@akeru/contracts";
import { ProviderInstanceId } from "@akeru/contracts";
import type { AkeruToolRuntime } from "../../AkeruToolRuntime.ts";
// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off

import {
  EventId,
  RuntimeRequestId,
  TurnId,
  AKERU_TOOL_CATALOG,
  type AkeruCreateRoutineInput,
  type ProviderRuntimeEvent,
  ThreadId,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  AKERU_CREATE_ROUTINE_TOOL_NAME,
} from "@akeru/contracts";

import * as Effect from "effect/Effect";

import { akeruActionNeedsApproval } from "../../AkeruMastraHarness.ts";

import type { PendingWaiters } from "../../PendingWaiters.ts";

import { isMemoryToolId } from "../../AkeruToolRuntime.ts";

import { isCodexComputerUseTool } from "../../CodexComputerUse.ts";

import { AgentControllerRuntimeError, ProviderValidationError } from "../../Errors.ts";
import { type AgentControllerShape } from "../../Services/AgentController.ts";
import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";
import { RoutineDraftDispatcher } from "../../../routines/RoutineDraftDispatcher.ts";

import { type ResolvedEngine, type ActiveSession } from "./State.ts";

export function createApprovals(deps: {
  readonly sessions: Map<string, ActiveSession>;
  readonly usesMastraCode: (provider: ProviderDriverKind) => boolean;
  readonly resolvedByThread: Map<string, ResolvedEngine>;
  readonly legacyProviderBridge: LegacyProviderBridge["Service"];
  readonly disabledProviderError: (
    operation: string,
    providerInstanceId: ProviderInstanceId,
  ) => ProviderValidationError;
  readonly pendingRoutineRequests: PendingWaiters<
    {
      readonly threadId: string;
      readonly input: AkeruCreateRoutineInput;
      readonly timezone: string;
    },
    unknown,
    Error
  >;
  readonly turnStillWaiting: (threadId: string, active: ActiveSession) => boolean;
  readonly publish: (event: ProviderRuntimeEvent) => void;
  readonly baseEvent: (
    threadId: ThreadId,
    active: Pick<ActiveSession, "provider" | "providerInstanceId">,
    turnId?: TurnId,
  ) => {
    turnId?: TurnId;
    eventId: EventId;
    provider: ProviderDriverKind;
    providerInstanceId: ProviderInstanceId;
    threadId: ThreadId;
    createdAt: string;
  };
  readonly publishSessionState: (
    threadId: ThreadId,
    active: ActiveSession,
    state: "ready" | "running" | "waiting" | "stopped" | "error",
    reason?: string,
  ) => void;
  readonly creatingRoutineReviews: Map<string, string>;
  readonly routineDispatcher: RoutineDraftDispatcher["Service"] | undefined;
  readonly ThreadIdBrand: (value: string) => ThreadId;
  readonly toolRuntime: AkeruToolRuntime;
  readonly approvalDecision: (decision: ProviderApprovalDecision) => "approve" | "decline";
  readonly runMastra: <A>(
    operation: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) => Effect.Effect<A, AgentControllerRuntimeError, never>;
}) {
  const respondToRequest: AgentControllerShape["respondToRequest"] = Effect.fn(
    "AgentController.respondToRequest",
  )(function* (input) {
    const key = String(input.threadId);
    const active = deps.sessions.get(key);

    if (!active) {
      if (
        deps.usesMastraCode(
          deps.resolvedByThread.get(key)?.provider ?? ProviderDriverKind.make("codex"),
        )
      ) {
        return yield* new AgentControllerRuntimeError({
          operation: "respondToRequest",
          detail: `Stale pending approval request: ${input.requestId}. The bot session restarted. Send the request again.`,
        });
      }

      return yield* deps.legacyProviderBridge.respondToRequest(input);
    }

    const routing = yield* deps.legacyProviderBridge.getInstanceInfo(active.providerInstanceId);

    if (!routing.enabled) {
      return yield* deps.disabledProviderError(
        "AgentController.respondToRequest",
        active.providerInstanceId,
      );
    }

    if (!active.activeTurn) {
      return yield* new AgentControllerRuntimeError({
        operation: "respondToRequest",
        detail: `Stale pending approval request: ${input.requestId}. The bot turn has ended. Send the request again.`,
      });
    }

    const toolCallId = String(input.requestId);
    const openRoutineRequest = deps.pendingRoutineRequests.get(toolCallId);

    if (openRoutineRequest && openRoutineRequest.threadId !== key) {
      return yield* new AgentControllerRuntimeError({
        operation: "respondToRequest",
        detail: `The routine review belongs to another chat: ${input.requestId}.`,
      });
    }

    // Claiming the review first stops its timeout, so an answer that arrives
    // in time always decides the outcome even if creation outlasts the limit.
    const routineRequest = deps.pendingRoutineRequests.claim(toolCallId);

    if (routineRequest) {
      // The review stays open until its answer has taken effect, so an
      // accepted review keeps the turn waiting while the routine is created.
      const resolveReview = (outcome?: "failed") =>
        Effect.sync(() => {
          const current = deps.sessions.get(key);

          if (!current?.activeTurn) return;
          current.activeTurn.waiting = deps.turnStillWaiting(key, current);
          deps.publish({
            ...deps.baseEvent(input.threadId, current, current.activeTurn.turnId),
            requestId: RuntimeRequestId.make(toolCallId),
            type: "request.resolved",
            payload: {
              requestType: "dynamic_tool_call" as const,
              decision: input.decision,
              ...(outcome ? { outcome } : {}),
            },
          });
          deps.publishSessionState(
            input.threadId,
            current,
            current.activeTurn.waiting ? "waiting" : "running",
          );
        });

      if (input.decision === "decline" || input.decision === "cancel") {
        yield* resolveReview();
        deps.pendingRoutineRequests.resolve(toolCallId, { status: "cancelled" });

        return;
      }

      deps.creatingRoutineReviews.set(toolCallId, key);
      let created = false;
      yield* deps
        .routineDispatcher!.createApprovedForThread(
          deps.ThreadIdBrand(routineRequest.threadId),
          routineRequest.timezone,
          routineRequest.input,
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentControllerRuntimeError({
                operation: "respondToRequest.routine",
                detail: cause.message,
                cause,
              }),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              created = true;
              deps.pendingRoutineRequests.resolve(toolCallId, result);
            }),
          ),
          Effect.tapError((cause) =>
            Effect.sync(() => {
              deps.pendingRoutineRequests.reject(toolCallId, cause);
            }),
          ),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              deps.pendingRoutineRequests.reject(
                toolCallId,
                new Error("The routine review was interrupted before the routine was created."),
              );
            }),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              deps.creatingRoutineReviews.delete(toolCallId);

              return resolveReview(created ? undefined : "failed");
            }),
          ),
        );

      return;
    }

    const toolRequest = active.approvalRequests.get(toolCallId);
    const pendingApproval = active.pendingApprovals.get(toolCallId);

    if (!toolRequest || !pendingApproval) {
      return yield* new AgentControllerRuntimeError({
        operation: "respondToRequest",
        detail: `Stale pending approval request: ${input.requestId}. The request is no longer active.`,
      });
    }

    const { name: toolName, input: toolInput } = toolRequest;
    const akeruTool = AKERU_TOOL_CATALOG.find((tool) => tool.id === toolName);
    const runtimeToolId = akeruTool?.id ?? (isMemoryToolId(toolName) ? toolName : undefined);

    const acceptForSession =
      input.decision === "acceptForSession" &&
      !runtimeToolId &&
      !isCodexComputerUseTool(toolName) &&
      !akeruActionNeedsApproval(toolName, toolInput) &&
      toolName !== AKERU_PRODUCT_FEEDBACK_TOOL_NAME;

    const enableAutoReview =
      input.decision === "acceptAlways" &&
      !isCodexComputerUseTool(toolName) &&
      !akeruActionNeedsApproval(toolName, toolInput) &&
      toolName !== AKERU_PRODUCT_FEEDBACK_TOOL_NAME &&
      toolName !== AKERU_CREATE_ROUTINE_TOOL_NAME;

    const target = pendingApproval.toolName;

    const decision =
      input.decision === "acceptForSession" || input.decision === "acceptAlways"
        ? "accept"
        : input.decision;

    const admitted = yield* deps.legacyProviderBridge.dispatchIfEnabled(
      active.providerInstanceId,
      "AgentController.respondToRequest",
      () => {
        if (!active.activeTurn || active.approvalRequests.get(toolCallId) !== toolRequest) {
          return { _tag: "Stale" as const };
        }

        active.approvalRequests.delete(toolCallId);
        active.pendingApprovals.delete(toolCallId);

        if (runtimeToolId && input.decision !== "decline" && input.decision !== "cancel") {
          deps.toolRuntime.grantApproval({
            threadId: key,
            toolCallId,
            toolId: runtimeToolId,
            input: toolInput,
          });
        }

        // Auto Review lets permissionPolicy run the rest of this session; risky
        // one-use actions still ask.
        if (enableAutoReview) active.runtimeMode = "auto";

        const update = acceptForSession
          ? active.session.permissions.setForTool({ toolName, policy: "allow" })
          : undefined;

        if (acceptForSession) active.connectorSessionApprovals.add(toolName);

        if (active.activeTurn) active.activeTurn.waiting = deps.turnStillWaiting(key, active);
        active.session.respondToToolApproval({
          toolCallId,
          decision:
            runtimeToolId && input.decision !== "decline" && input.decision !== "cancel"
              ? "approve"
              : deps.approvalDecision(decision),
        });

        return { _tag: "Dispatched" as const, permissionUpdate: update };
      },
    );

    if (Predicate.isTagged(admitted, "Stale")) {
      return yield* new AgentControllerRuntimeError({
        operation: "respondToRequest",
        detail: `Stale pending approval request: ${input.requestId}. The bot turn has ended. Send the request again.`,
      });
    }

    const permissionUpdate = admitted.permissionUpdate;

    if (permissionUpdate) {
      yield* deps.runMastra("permissions.setForTool", () => permissionUpdate);
    }

    deps.publish({
      ...deps.baseEvent(input.threadId, active, active.activeTurn?.turnId),
      requestId: RuntimeRequestId.make(toolCallId),
      type: "request.resolved",
      payload: {
        requestType: "dynamic_tool_call" as const,
        decision,
        actor: "user",
        target,
        action: pendingApproval.action,
        outcome: decision === "accept" ? "approved" : "denied",
      },
    });
    deps.publishSessionState(
      input.threadId,
      active,
      active.activeTurn?.waiting ? "waiting" : "running",
    );
  });

  const respondToUserInput: AgentControllerShape["respondToUserInput"] = Effect.fn(
    "AgentController.respondToUserInput",
  )(function* (input) {
    const key = String(input.threadId);
    const active = deps.sessions.get(key);

    if (!active) {
      if (
        deps.usesMastraCode(
          deps.resolvedByThread.get(key)?.provider ?? ProviderDriverKind.make("codex"),
        )
      ) {
        return yield* new AgentControllerRuntimeError({
          operation: "respondToUserInput",
          detail: `Unknown pending user-input request: ${input.requestId}. The bot session restarted. Send the request again.`,
        });
      }

      return yield* deps.legacyProviderBridge.respondToUserInput(input);
    }

    const routing = yield* deps.legacyProviderBridge.getInstanceInfo(active.providerInstanceId);

    if (!routing.enabled) {
      return yield* deps.disabledProviderError(
        "AgentController.respondToUserInput",
        active.providerInstanceId,
      );
    }

    const toolCallId = String(input.requestId);
    const answer = input.answers[toolCallId];

    if (answer === undefined) {
      return yield* new AgentControllerRuntimeError({
        operation: "respondToToolSuspension",
        detail: `No answer was supplied for pending user-input request '${toolCallId}'.`,
      });
    }

    const activeTurn = active.activeTurn;
    // Only a question this turn was waiting on goes back into its set on failure.
    let ownedByTurn = false;
    let restored = false;
    let resumeFailure: string | undefined;

    const unsubscribe = active.session.subscribe((event) => {
      if (event.type === "tool_suspension_cancelled" && event.toolCallId === toolCallId) {
        resumeFailure = event.reason;
      } else if (event.type === "error") {
        resumeFailure ??= event.error.message;
      }
    });

    yield* Effect.gen(function* () {
      const admitted = yield* deps.legacyProviderBridge.dispatchIfEnabled(
        active.providerInstanceId,
        "AgentController.respondToUserInput",
        () => {
          if (!activeTurn || active.activeTurn !== activeTurn) {
            return { _tag: "Stale" as const };
          }

          ownedByTurn = activeTurn.suspendedToolCalls.delete(toolCallId);
          activeTurn.waiting = deps.turnStillWaiting(key, active);

          return {
            _tag: "Dispatched" as const,
            resume: active.session.respondToToolSuspension({ toolCallId, resumeData: answer }),
          };
        },
      );

      if (Predicate.isTagged(admitted, "Stale")) {
        return yield* new AgentControllerRuntimeError({
          operation: "respondToUserInput",
          detail: `Unknown pending user-input request: ${input.requestId}. The bot turn has ended. Send the request again.`,
        });
      }

      yield* deps
        .runMastra("respondToToolSuspension", () => admitted.resume)
        .pipe(
          // A rejected resume leaves the question open while its turn is still live.
          Effect.onError(() =>
            Effect.sync(() => {
              if (
                !ownedByTurn ||
                !activeTurn ||
                active.activeTurn !== activeTurn ||
                resumeFailure !== undefined
              )
                return;
              activeTurn.suspendedToolCalls.add(toolCallId);
              activeTurn.waiting = deps.turnStillWaiting(key, active);
              restored = true;
            }),
          ),
          Effect.mapError((error) =>
            restored
              ? new AgentControllerRuntimeError({
                  operation: error.operation,
                  detail: error.detail,
                  cause: error.cause,
                  retryable: true,
                })
              : error,
          ),
        );
    }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));

    if (resumeFailure !== undefined) {
      return yield* new AgentControllerRuntimeError({
        operation: "respondToToolSuspension",
        detail: `Unknown pending user-input request: ${toolCallId}. ${resumeFailure}`,
        cause: new Error(resumeFailure),
      });
    }

    deps.publish({
      ...deps.baseEvent(input.threadId, active, active.activeTurn?.turnId),
      requestId: RuntimeRequestId.make(toolCallId),
      type: "user-input.resolved",
      payload: { answers: input.answers },
    });
    deps.publishSessionState(
      input.threadId,
      active,
      active.activeTurn?.waiting ? "waiting" : "running",
    );
  });

  return { respondToRequest, respondToUserInput };
}
