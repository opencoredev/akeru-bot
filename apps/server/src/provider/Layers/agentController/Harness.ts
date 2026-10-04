import type { AuthStorage } from "@mastra/code-sdk/auth/storage";
import type { createSessionContext } from "./SessionContext.ts";
import type { AkeruToolRuntime } from "../../AkeruToolRuntime.ts";
import type { AgentControllerLiveOptions } from "./Options.ts";
import { failureDetail, ThreadIdBrand } from "./Policy.ts";

import * as NodeCrypto from "node:crypto";

import * as Path from "effect/Path";

import {
  AkeruUsageReservationId,
  CommandId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  RoutineId,
  TurnId,
  type BotId,
  type AkeruCreateRoutineInput,
  type ProviderRuntimeEvent,
  ThreadId,
  AKERU_CREATE_ROUTINE_TOOL_NAME,
} from "@akeru/contracts";

import * as Effect from "effect/Effect";

import * as Option from "effect/Option";

import { ServerConfig } from "../../../config.ts";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

import {
  AKERU_TURN_USAGE_RESERVATION_TOKENS,
  BotUsageLedger,
} from "../../../usage/BotUsageLedger.ts";
import { SubscriptionAuthService } from "../../../subscription-auth/service.ts";
import { makeAkeruMastraHarness } from "../../AkeruMastraHarness.ts";

import { AKERU_ROUTINE_REVIEW_TIMEOUT, type PendingWaiters } from "../../PendingWaiters.ts";

import { AkeruSessionResources } from "../../AkeruSessionResources.ts";

import { AgentControllerRuntimeError } from "../../Errors.ts";

import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";
import { RoutineDraftDispatcher } from "../../../routines/RoutineDraftDispatcher.ts";

import { type ActiveSession } from "./State.ts";

import { nowIso } from "./EventIdentity.ts";

export function createHarness(deps: {
  readonly options: AgentControllerLiveOptions | undefined;
  readonly authStorage: AuthStorage;
  readonly subscriptionAuth: SubscriptionAuthService;
  readonly modelConnections: Map<
    string,
    {
      readonly environment: NodeJS.ProcessEnv;
      readonly instanceEnvironment: NodeJS.ProcessEnv;
      readonly useSavedCredential: boolean;
    }
  >;
  readonly config: ServerConfig["Service"];
  readonly sessions: Map<string, ActiveSession>;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly legacyProviderBridge: LegacyProviderBridge["Service"];
  readonly sessionResources: AkeruSessionResources;
  readonly orchestrationEngine: Option.Option<OrchestrationEngineService["Service"]>;
  readonly routineDispatcher: RoutineDraftDispatcher["Service"] | undefined;
  readonly pendingRoutineRequests: PendingWaiters<
    {
      readonly threadId: string;
      readonly input: AkeruCreateRoutineInput;
      readonly timezone: string;
    },
    unknown,
    Error
  >;
  readonly publishSessionState: (
    threadId: ThreadId,
    active: ActiveSession,
    state: "ready" | "running" | "waiting" | "stopped" | "error",
    reason?: string,
  ) => void;
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
  readonly turnStillWaiting: (threadId: string, active: ActiveSession) => boolean;
  readonly toolRuntime: AkeruToolRuntime;
  readonly memoryUsageByThread: Map<string, { readonly botId: BotId; turnId: TurnId }>;
  readonly readSessionStartContext: ReturnType<
    typeof createSessionContext
  >["readSessionStartContext"];
  readonly unreservedMemoryCalls: Map<
    string,
    {
      readonly botId: BotId;
      readonly threadId: ThreadId;
      readonly category: "observer" | "reflector";
      readonly provider: ProviderDriverKind | null;
      readonly model: string | null;
    }
  >;
  readonly botUsageLedger: BotUsageLedger["Service"];
}) {
  const routineDispatcher = deps.routineDispatcher;

  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const makeMastraHarness = deps.options?.makeMastraHarness ?? makeAkeruMastraHarness;

    const bundle = yield* makeMastraHarness({
      authStorage: deps.authStorage,
      getKimiAccess: (instanceId) => deps.subscriptionAuth.getKimiForCodingAccess(instanceId),
      getOpenCodeGoApiKey: async (instanceId) =>
        deps.subscriptionAuth.getApiKeyCredential("opencode-go", instanceId)?.access,
      getSubscriptionApiKey: (provider, instanceId) =>
        deps.subscriptionAuth.getApiKeyCredential(provider, instanceId),
      getSubscriptionOAuth: (provider, instanceId) =>
        deps.subscriptionAuth.getOAuthCredential(provider, instanceId),
      getSubscriptionAccessToken: (provider, instanceId) =>
        deps.subscriptionAuth.getAccessToken(provider, instanceId),
      getModelConnection: (providerInstanceId) => {
        const connection = deps.modelConnections.get(providerInstanceId);

        return connection ? { ...connection, instanceId: providerInstanceId } : undefined;
      },
      memoryDbPath: path.join(deps.config.stateDir, "mastra-observational-memory.sqlite"),
      syncThreadToolApproval: async (threadId, toolName, protectedAction) => {
        const active = deps.sessions.get(threadId);
        const activeTurn = active?.activeTurn;

        if (
          !active ||
          !activeTurn ||
          (!protectedAction && !active.connectorSessionApprovals.has(toolName))
        ) {
          return;
        }

        const update = await deps.runPromise(
          deps.legacyProviderBridge.dispatchIfEnabled(
            active.providerInstanceId,
            "AgentController.syncThreadToolApproval",
            () => {
              if (deps.sessions.get(threadId) !== active || active.activeTurn !== activeTurn)
                return;

              return active.session.permissions.setForTool({
                toolName,
                policy: protectedAction ? "ask" : "allow",
              });
            },
          ),
        );

        await update;
      },
      getThreadTools: (threadId) => deps.sessionResources.getConnectorTools(threadId),
      // Durable queue rows can drain before any client opens the thread (for
      // example right after a server restart), so the activity must not
      // depend on an active provider session; the row's recorded turnId is
      // the authority and the active turn is only a fallback.
      onObservationDropped: async ({
        observationId,
        threadId,
        turnId,
        resourceId,
        modelId,
        attempts,
        error,
      }) => {
        if (!Option.isSome(deps.orchestrationEngine)) return;
        const active = deps.sessions.get(threadId);
        const droppedAt = nowIso();
        await deps.runPromise(
          deps.orchestrationEngine.value.dispatch({
            type: "thread.activity.append",
            // Stable ids make a retried notice idempotent.
            commandId: CommandId.make(`server:observation-dropped:${observationId}`),
            threadId: ThreadIdBrand(threadId),
            activity: {
              id: EventId.make(`observation-dropped:${observationId}`),
              tone: "error",
              kind: "memory.observation.dropped",
              summary: "Background memory observation dropped after repeated failures",
              payload: {
                resourceId,
                modelId: modelId ?? null,
                attempts,
                detail: error.message,
              },
              turnId: turnId ? TurnId.make(turnId) : (active?.activeTurn?.turnId ?? null),
              createdAt: droppedAt,
            },
            createdAt: droppedAt,
          }),
        );
      },
      ...(routineDispatcher
        ? {
            listRoutines: (threadId: string) =>
              deps.runPromise(
                routineDispatcher
                  .listForThread(ThreadIdBrand(threadId))
                  .pipe(Effect.map((routines) => ({ routines: [...routines] }))),
              ),
            deleteRoutines: (threadId: string, routineIds: ReadonlyArray<string>) =>
              deps.runPromise(
                routineDispatcher
                  .deleteForThread(
                    ThreadIdBrand(threadId),
                    routineIds.map((routineId) => RoutineId.make(routineId)),
                  )
                  .pipe(
                    Effect.map((result) => ({
                      status: result.status,
                      deletedRoutineIds: [...result.routineIds],
                    })),
                  ),
              ),
            createRoutine: (threadId: string, input: AkeruCreateRoutineInput) => {
              const active = deps.sessions.get(threadId);
              const timezone = active?.toolSession.timezone;

              if (!timezone) {
                return Promise.reject(new Error("Send a message before creating a routine."));
              }

              const requestId = `routine-${NodeCrypto.randomUUID()}`;

              return deps.runPromise(
                deps.pendingRoutineRequests
                  .wait(
                    requestId,
                    { threadId, input, timezone },
                    {
                      timeout: AKERU_ROUTINE_REVIEW_TIMEOUT,
                      timeoutMessage:
                        "The routine review expired without a response. Ask again to create the routine.",
                      onOpen: () => {
                        if (active.activeTurn) active.activeTurn.waiting = true;
                        deps.publishSessionState(ThreadIdBrand(threadId), active, "waiting");
                        deps.publish({
                          ...deps.baseEvent(
                            ThreadIdBrand(threadId),
                            active,
                            active.activeTurn?.turnId,
                          ),
                          requestId: RuntimeRequestId.make(requestId),
                          type: "request.opened",
                          payload: {
                            requestType: "dynamic_tool_call",
                            detail: "Review routine",
                            toolName: AKERU_CREATE_ROUTINE_TOOL_NAME,
                            args: { ...input, timezone },
                            options: [
                              { decision: "accept", label: "Create routine" },
                              { decision: "decline", label: "Cancel" },
                            ],
                          },
                        });
                      },
                    },
                  )
                  .pipe(
                    Effect.tapErrorTag("PendingWaiterTimeoutError", () =>
                      Effect.sync(() => {
                        // Close the review card so the chat no longer waits on the user.
                        const current = deps.sessions.get(threadId);

                        if (!current?.activeTurn) return;
                        current.activeTurn.waiting = deps.turnStillWaiting(threadId, current);
                        deps.publish({
                          ...deps.baseEvent(
                            ThreadIdBrand(threadId),
                            current,
                            current.activeTurn.turnId,
                          ),
                          requestId: RuntimeRequestId.make(requestId),
                          type: "request.resolved",
                          payload: {
                            requestType: "dynamic_tool_call" as const,
                            decision: "cancel",
                            actor: "system",
                            target: AKERU_CREATE_ROUTINE_TOOL_NAME,
                            outcome: "cancelled",
                          },
                        });
                        deps.publishSessionState(
                          ThreadIdBrand(threadId),
                          current,
                          current.activeTurn.waiting ? "waiting" : "running",
                        );
                      }),
                    ),
                  ),
              );
            },
          }
        : {}),
      toolRuntime: deps.toolRuntime,
      startMemoryCall: async ({ threadId, category }) => {
        const context = deps.memoryUsageByThread.get(threadId);
        const active = deps.sessions.get(threadId);
        const callId = `${category}:${NodeCrypto.randomUUID()}`;

        if (!context || !active) {
          // A queued observation can drain after a restart before its chat
          // reopens. Attribute it to the chat's bot and record what it used.
          const botId = await deps.runPromise(
            deps.readSessionStartContext(ThreadIdBrand(threadId), null).pipe(
              Effect.map((started) => started.botId),
              Effect.catchCause(() => Effect.succeed(null)),
            ),
          );

          if (!botId) return undefined;
          deps.unreservedMemoryCalls.set(callId, {
            botId,
            threadId: ThreadIdBrand(threadId),
            category,
            provider: active?.provider ?? null,
            model: active?.model ?? null,
          });

          return callId;
        }

        await deps.runPromise(
          deps.botUsageLedger.reserve({
            reservationId: AkeruUsageReservationId.make(callId),
            sourceKey: callId,
            botId: context.botId,
            threadId: ThreadIdBrand(threadId),
            turnId: context.turnId,
            category,
            maximumTokens: AKERU_TURN_USAGE_RESERVATION_TOKENS,
            provider: active.provider,
            model: active.model,
            createdAt: nowIso(),
          }),
        );

        return callId;
      },
      finishMemoryCall: async ({ callId, usage, error }) => {
        const outputTokens = usage?.outputTokens ?? 0;

        const inputTokens =
          usage?.inputTokens ?? Math.max(0, (usage?.totalTokens ?? 0) - outputTokens);

        const unreserved = deps.unreservedMemoryCalls.get(callId);

        if (unreserved) {
          deps.unreservedMemoryCalls.delete(callId);

          if (!usage) return;
          await deps.runPromise(
            deps.botUsageLedger.recordMeasurement({
              reservationId: AkeruUsageReservationId.make(callId),
              sourceKey: callId,
              botId: unreserved.botId,
              threadId: unreserved.threadId,
              turnId: null,
              category: unreserved.category,
              inputTokens,
              outputTokens,
              reasoningTokens: null,
              provider: unreserved.provider,
              model: unreserved.model,
              createdAt: nowIso(),
            }),
          );

          return;
        }

        await deps.runPromise(
          deps.botUsageLedger.settle(
            usage
              ? {
                  reservationId: AkeruUsageReservationId.make(callId),
                  state: "reported",
                  inputTokens,
                  outputTokens,
                  reasoningTokens: null,
                  settledAt: nowIso(),
                }
              : error
                ? {
                    reservationId: AkeruUsageReservationId.make(callId),
                    state: "unavailable",
                    reason: error.message || "Observational Memory usage was unavailable.",
                    settledAt: nowIso(),
                  }
                : {
                    reservationId: AkeruUsageReservationId.make(callId),
                    state: "released",
                    settledAt: nowIso(),
                  },
          ),
        );
      },
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AgentControllerRuntimeError({
            operation: "construct",
            detail: failureDetail(cause),
            cause,
          }),
      ),
    );

    return { makeMastraHarness, bundle };
  });
}
