import * as Predicate from "effect/Predicate";
import { ProviderDriverKind } from "@akeru/contracts";
import { ProviderInstanceId } from "@akeru/contracts";
import type { AkeruToolRuntime } from "../../AkeruToolRuntime.ts";
import type { ProviderServiceError } from "../../Errors.ts";
import type { AgentControllerLiveOptions } from "./Options.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import {
  TurnId,
  type ProviderRuntimeEvent,
  ThreadId,
  type AkeruMemoryThreadAccess,
} from "@akeru/contracts";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import { resolveAttachmentPath } from "../../../attachmentStore.ts";

import { ServerConfig } from "../../../config.ts";

import * as McpMemoryToolSession from "../../../mcp/McpMemoryToolSession.ts";

import { type AkeruMastraHarness } from "../../AkeruMastraHarness.ts";
import { createAkeruBotTurnInstructions } from "../../AkeruAgentInstructions.ts";

import { AkeruMemoryTurnHarness } from "../../AkeruMemoryTurnHarness.ts";

import { cancelActiveImageGenerations } from "../../../image-generation/ImageGenerationRuntime.ts";

import { AgentControllerRuntimeError, ProviderValidationError } from "../../Errors.ts";
import { type AgentControllerShape } from "../../Services/AgentController.ts";
import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";

import {
  type ResolvedEngine,
  type PendingTurn,
  type ActiveSession,
  type LegacyTurnMemoryState,
  type LegacyResourceIdentity,
} from "./State.ts";

export function createTurnRequests(deps: {
  readonly resolvedByThread: Map<string, ResolvedEngine>;
  readonly sessions: Map<string, ActiveSession>;
  readonly usesMastraCode: (provider: ProviderDriverKind) => boolean;
  readonly legacyProviderBridge: LegacyProviderBridge["Service"];
  readonly disabledProviderError: (
    operation: string,
    providerInstanceId: ProviderInstanceId,
  ) => ProviderValidationError;
  readonly memorySettings: () =>
    | Effect.Effect<
        | { enabled: boolean; privateBotMemory: boolean; sharedProjectMemory: "auto" | "ask" }
        | { enabled: boolean; privateBotMemory: boolean; sharedProjectMemory: "ask" },
        never,
        never
      >
    | Effect.Effect<
        {
          readonly enabled: true;
          readonly privateBotMemory: true;
          readonly sharedProjectMemory: "ask";
        },
        never,
        never
      >;
  readonly legacyResourceIdentity: Map<string, LegacyResourceIdentity>;
  readonly runMastra: <A>(
    operation: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) => Effect.Effect<A, AgentControllerRuntimeError, never>;
  readonly refreshEntityMemoryAccess: (
    access: AkeruMemoryThreadAccess | undefined,
  ) => Promise<AkeruMemoryThreadAccess | undefined>;
  readonly entityMemoryContext: (access: AkeruMemoryThreadAccess | undefined) => Promise<string>;
  readonly bundle: AkeruMastraHarness;
  readonly memoryTurnHarness: AkeruMemoryTurnHarness;
  readonly addLegacyPending: (
    key: string,
    pending: LegacyTurnMemoryState,
  ) => Map<string, LegacyTurnMemoryState[]>;
  readonly hasLegacyPending: (key: string, pending: LegacyTurnMemoryState) => boolean;
  readonly legacyHiddenWakeByTurn: Map<string, boolean>;
  readonly drainLegacyTerminals: (key: string) => Effect.Effect<void, never, never>;
  readonly restoreLegacyMemoryHandler: (key: string, pending: LegacyTurnMemoryState) => void;
  readonly removeLegacyPending: (key: string, pending: LegacyTurnMemoryState) => void;
  readonly toolRuntime: AkeruToolRuntime;
  readonly config: ServerConfig["Service"];
  readonly options: AgentControllerLiveOptions | undefined;
  readonly admitPendingTurn: (
    active: ActiveSession,
    pending: PendingTurn,
  ) => Effect.Effect<void, ProviderServiceError, never>;
  readonly handlePendingTurnFailure: (
    active: ActiveSession,
    pending: PendingTurn,
    cause: unknown,
  ) => Promise<void>;
  readonly legacyPending: (key: string) => LegacyTurnMemoryState[];
  readonly legacyTurnMemory: Map<string, LegacyTurnMemoryState[]>;
  readonly legacyBufferedTerminals: Map<string, Map<string, ProviderRuntimeEvent>>;
  readonly endTurnAdmissionGeneration: (active: ActiveSession) => void;
  readonly releaseMastraReservations: (threadId: ThreadId) => Effect.Effect<void, never, never>;
  readonly finishTurn: (
    threadId: ThreadId,
    active: ActiveSession,
    state: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ) => void;
}) {
  const sendTurn: AgentControllerShape["sendTurn"] = Effect.fn("AgentController.sendTurn")(
    function* (input) {
      const key = String(input.threadId);
      const resolved = deps.resolvedByThread.get(key);
      const active = deps.sessions.get(key);

      if (!active) {
        if (resolved && deps.usesMastraCode(resolved.provider)) {
          const routing = yield* deps.legacyProviderBridge.getInstanceInfo(
            resolved.providerInstanceId,
          );

          if (!routing.enabled) {
            return yield* deps.disabledProviderError(
              "AgentController.sendTurn",
              resolved.providerInstanceId,
            );
          }
        }

        if (
          deps.usesMastraCode(
            deps.resolvedByThread.get(key)?.provider ?? ProviderDriverKind.make("codex"),
          )
        ) {
          return yield* new AgentControllerRuntimeError({
            operation: "sendTurn",
            detail: `Mastra session for thread '${input.threadId}' is not running.`,
          });
        }

        const { botUsage: _, delegationResults, ...providerInput } = input;
        // memory.enabled is authoritative per turn: while it is off the turn
        // must not read the durable snapshot or reserve review cadence. The
        // identity keeps its stored access so re-enabling restores memory.
        const settings = yield* deps.memorySettings();

        const memoryAccess = settings.enabled
          ? deps.legacyResourceIdentity.get(key)?.memoryAccess
          : undefined;

        const entityMemoryAccess = settings.enabled
          ? yield* deps.runMastra("memory.access", () =>
              deps.refreshEntityMemoryAccess(
                deps.legacyResourceIdentity.get(key)?.entityMemoryAccess,
              ),
            )
          : undefined;

        if (
          settings.enabled &&
          deps.legacyResourceIdentity.get(key)?.entityMemoryAccess &&
          !entityMemoryAccess
        ) {
          return yield* new AgentControllerRuntimeError({
            operation: "sendTurn.memory",
            detail: "The bot is no longer a member of this group.",
          });
        }

        const entityPacket = entityMemoryAccess
          ? yield* deps.runMastra("memory.packet", () =>
              deps.entityMemoryContext(entityMemoryAccess),
            )
          : "";

        const conversation = deps.bundle.readObservationalMemory
          ? yield* deps.runMastra("memory.read", () =>
              deps.bundle.readObservationalMemory!(key, key),
            )
          : undefined;

        const observationContext = conversation?.current?.activeObservations
          ? [
              "<thread-observations>",
              conversation.current.activeObservations,
              "</thread-observations>",
            ].join("\n")
          : "";

        const memoryTurn = memoryAccess
          ? yield* Effect.promise(() =>
              deps.memoryTurnHarness.admit({
                access: memoryAccess,
                input: {
                  threadId: key,
                  groupId: memoryAccess.groupId === null ? null : String(memoryAccess.groupId),
                  text: (providerInput.input ?? "").slice(0, 4_000),
                },
                privateBotMemory: settings.privateBotMemory,
              }),
            )
          : undefined;

        const pendingMemory: LegacyTurnMemoryState = {
          observationPromptId: NodeCrypto.randomUUID(),
          observationRecorded: false,
          seenEventIds: new Set(),
          user: providerInput.input ?? "",
          modelId: resolved?.mastraModelId ?? "openai/gpt-5.6-sol",
          turnId: undefined,
          dispatchReturned: false,
          earlyEvents: [],
          assistant: "",
          memoryTurn,
          hiddenWake: input.hiddenWake === true,
        };

        if (memoryTurn?.reviewIncluded) {
          const priorMemoryHandler = McpMemoryToolSession.readMcpMemoryToolSession(input.threadId);

          if (priorMemoryHandler) {
            const reviewMemoryHandler = memoryTurn.wrapMemoryHandler(priorMemoryHandler);
            pendingMemory.priorMemoryHandler = priorMemoryHandler;
            pendingMemory.reviewMemoryHandler = reviewMemoryHandler;
            McpMemoryToolSession.setMcpMemoryToolSession(input.threadId, reviewMemoryHandler);
          }
        }

        deps.addLegacyPending(key, pendingMemory);

        const turnInstructions = resolved?.botConversation
          ? createAkeruBotTurnInstructions({
              ...(resolved.botName ? { name: resolved.botName } : {}),
              ...(resolved.personalityTone !== undefined
                ? { personalityTone: resolved.personalityTone }
                : {}),
            })
          : "";

        // OpenCode reads per-turn context as its system prompt. Claude and Grok
        // only read context at session start, so this turn's text carries it.
        const contextInSystem = resolved?.provider === "opencode";

        const providerContext = [
          contextInSystem ? turnInstructions : "",
          memoryTurn?.context,
          entityPacket,
          observationContext,
          contextInSystem ? delegationResults : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        const inputPrefix = contextInSystem ? [] : [turnInstructions, delegationResults];

        return yield* deps.legacyProviderBridge
          .sendTurn({
            ...providerInput,
            ...(inputPrefix.some(Boolean)
              ? { input: [...inputPrefix, providerInput.input].filter(Boolean).join("\n\n") }
              : {}),
            ...(providerContext ? { persistentMemoryContext: providerContext } : {}),
          })
          .pipe(
            Effect.tap((result) =>
              Effect.gen(function* () {
                if (!deps.hasLegacyPending(key, pendingMemory)) return;
                pendingMemory.turnId = String(result.turnId);

                if (input.hiddenWake === true)
                  deps.legacyHiddenWakeByTurn.set(`${key}:${pendingMemory.turnId}`, true);
                pendingMemory.dispatchReturned = true;

                for (const event of pendingMemory.earlyEvents) {
                  if (String(event.turnId) !== pendingMemory.turnId) continue;

                  if (
                    event.type === "content.delta" &&
                    event.payload.streamKind === "assistant_text"
                  ) {
                    pendingMemory.assistant += event.payload.delta;
                  }
                }

                pendingMemory.earlyEvents.length = 0;
                yield* deps.drainLegacyTerminals(key);
              }),
            ),
            Effect.tapError(() =>
              Effect.gen(function* () {
                if (deps.hasLegacyPending(key, pendingMemory)) {
                  deps.restoreLegacyMemoryHandler(key, pendingMemory);
                  deps.removeLegacyPending(key, pendingMemory);
                }

                if (memoryTurn) {
                  yield* Effect.promise(() => memoryTurn.abandon());
                }

                yield* deps.drainLegacyTerminals(key);
              }),
            ),
          );
      }

      const turnAdmissionGeneration = active.turnAdmissionGeneration;
      const turnPreparationCancelled = active.turnPreparationCancelled;

      const prepareTurn = active.turnPreparation.withPermit(
        Effect.gen(function* () {
          if (resolved && deps.usesMastraCode(resolved.provider)) {
            const routing = yield* deps.legacyProviderBridge.getInstanceInfo(
              resolved.providerInstanceId,
            );

            if (!routing.enabled) {
              return yield* deps.disabledProviderError(
                "AgentController.sendTurn",
                resolved.providerInstanceId,
              );
            }
          }

          if (input.timezone !== undefined) {
            active.configuredToolSession = {
              ...active.configuredToolSession,
              timezone: input.timezone,
            };

            if (!active.activeTurn && !active.admittingTurn && active.pendingTurns.length === 0) {
              active.toolSession = active.configuredToolSession;
              deps.toolRuntime.registerSession(key, active.toolSession);
            }
          }

          const attachmentFiles = yield* Effect.forEach(
            input.attachments ?? [],
            (attachment) => {
              const path = resolveAttachmentPath({
                attachmentsDir: deps.config.attachmentsDir,
                attachment,
              });

              if (path === null) {
                return Effect.fail(
                  new AgentControllerRuntimeError({
                    operation: "sendTurn.attachments",
                    detail: `Attachment '${attachment.id}' has an invalid path.`,
                  }),
                );
              }

              return Effect.tryPromise({
                try: async () => {
                  const bytes = await (deps.options?.readAttachment ?? NodeFS.promises.readFile)(
                    path,
                  );

                  return {
                    file: {
                      data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
                        "base64",
                      ),
                      mediaType: attachment.mimeType,
                      filename: attachment.name,
                    },
                    pathLine: `[Attached ${attachment.type} "${attachment.name}" is saved at: ${path}]`,
                  };
                },
                catch: (cause) =>
                  new AgentControllerRuntimeError({
                    operation: "sendTurn.attachments",
                    detail: `Could not read attachment '${attachment.id}'.`,
                    cause,
                  }),
              });
            },
            { concurrency: 1 },
          );

          if (
            deps.sessions.get(key) !== active ||
            active.status === "closed" ||
            active.turnAdmissionGeneration !== turnAdmissionGeneration
          ) {
            return yield* new AgentControllerRuntimeError({
              operation: "sendTurn",
              detail: `Mastra session for thread '${input.threadId}' is not running.`,
            });
          }

          const content = [input.input, ...attachmentFiles.map(({ pathLine }) => pathLine)]
            .filter((part): part is string => Predicate.isString(part) && part.length > 0)
            .join("\n\n");

          const files = attachmentFiles.map(({ file }) => file);
          const turnId = TurnId.make(`mastra-turn-${NodeCrypto.randomUUID()}`);
          active.pendingTurns.push({
            threadId: input.threadId,
            turnId,
            message: { content, ...(files.length > 0 ? { files } : {}) },
            botUsage: input.botUsage,
            toolSession: active.configuredToolSession,
            memoryAccess: active.configuredMemoryAccess,
            entityMemoryAccess: active.configuredEntityMemoryAccess,
            reviewInput: input.input ?? "",
            hiddenWake: input.hiddenWake === true,
            delegationResults: input.delegationResults,
          });

          return turnId;
        }),
      );

      // An interrupt must not wait for a stalled attachment read: abandon the
      // preparation, release its permit, and fail turns still queued behind it.
      const turnId = yield* Effect.raceFirst(
        prepareTurn,
        Deferred.await(turnPreparationCancelled).pipe(
          Effect.andThen(
            Effect.fail(
              new AgentControllerRuntimeError({
                operation: "sendTurn",
                detail: `Mastra session for thread '${input.threadId}' is not running.`,
              }),
            ),
          ),
        ),
      );

      if (!active.activeTurn && !active.admittingTurn) {
        const nextTurn = active.pendingTurns.shift();

        if (nextTurn) {
          yield* deps
            .admitPendingTurn(active, nextTurn)
            .pipe(
              Effect.tapError((cause) =>
                Effect.promise(() => deps.handlePendingTurnFailure(active, nextTurn, cause)),
              ),
            );
        }
      }

      return { threadId: input.threadId, turnId };
    },
  );

  const interruptTurn: AgentControllerShape["interruptTurn"] = Effect.fn(
    "AgentController.interruptTurn",
  )(function* (input) {
    const key = String(input.threadId);
    const active = deps.sessions.get(key);

    if (!active) {
      if (
        deps.usesMastraCode(
          deps.resolvedByThread.get(key)?.provider ?? ProviderDriverKind.make("codex"),
        )
      ) {
        return;
      }

      return yield* deps.legacyProviderBridge.interruptTurn(input).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const pendingTurns = deps.legacyPending(key);

            for (const pending of pendingTurns) deps.restoreLegacyMemoryHandler(key, pending);
            deps.legacyTurnMemory.delete(key);
            deps.legacyBufferedTerminals.delete(key);
            yield* Effect.forEach(
              pendingTurns,
              (pendingMemory) =>
                pendingMemory.memoryTurn
                  ? deps
                      .runMastra("memory.abandon", () => pendingMemory.memoryTurn!.abandon())
                      .pipe(Effect.ignoreCause({ log: true }))
                  : Effect.void,
              { discard: true },
            );
          }),
        ),
      );
    }

    deps.endTurnAdmissionGeneration(active);
    active.pendingTurns.length = 0;
    active.admittingTurn = null;
    active.session.abort();
    yield* cancelActiveImageGenerations(input.threadId);
    yield* deps.releaseMastraReservations(input.threadId);
    deps.finishTurn(input.threadId, active, "interrupted");
  });

  return { sendTurn, interruptTurn };
}
