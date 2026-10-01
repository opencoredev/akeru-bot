import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Effect from "effect/Effect";
import { AkeruMemoryId, AkeruMemoryOperationError, type AkeruMemoryMutationResult, WS_METHODS, WsRpcGroup } from "@akeru/contracts";
import { applyBotMemoryImport, exportBotMemoryArchive, previewBotMemoryImport } from "./memory/BotMemoryArchive.ts";
import { exportAkeruMemory } from "./memory/MemoryExport.ts";
import { applyAkeruMemoryImport, previewAkeruMemoryImport } from "./memory/MemoryImport.ts";

import { isOrchestrationDispatchCommandError, nowIso, memoryOperationError } from "./wsSupport.ts";
import type { WsConnection } from "./wsConnection.ts";

export const createWsMemoryHandlers = ({ agentController, entityMemoryRepository, memoryApprovals, botMemoryStore, serverSettings, resolveMemoryAccess, resolveBotMemoryAccess, readArchiveConversations, observeRpcEffect, randomUUID }: Pick<WsConnection, "agentController" | "entityMemoryRepository" | "memoryApprovals" | "botMemoryStore" | "serverSettings" | "resolveMemoryAccess" | "resolveBotMemoryAccess" | "readArchiveConversations" | "observeRpcEffect" | "randomUUID">) => ({

        [WS_METHODS.memoryExport]: (input) =>
          observeRpcEffect(
            WS_METHODS.memoryExport,
            Effect.all({
              access: resolveBotMemoryAccess("documents.export", input.threadId),
              createdAt: nowIso,
              conversation: agentController.readConversationMemory
                ? agentController
                    .readConversationMemory(input.threadId)
                    .pipe(
                      Effect.mapError((cause) => memoryOperationError("documents.export", cause)),
                    )
                : Effect.fail(
                    memoryOperationError(
                      "documents.export",
                      "Observational memory is unavailable.",
                    ),
                  ),
            }).pipe(
              Effect.flatMap(({ access, createdAt, conversation }) =>
                Effect.tryPromise({
                  try: () =>
                    exportBotMemoryArchive({
                      store: botMemoryStore,
                      access,
                      threadId: input.threadId,
                      conversation,
                      createdAt,
                    }),
                  catch: (cause) => memoryOperationError("documents.export", cause),
                }),
              ),
            ),
            { "rpc.aggregate": "memory" },
          ),

        [WS_METHODS.memoryImportPreview]: (input) =>
          observeRpcEffect(
            WS_METHODS.memoryImportPreview,
            Effect.all({
              access: resolveBotMemoryAccess("documents.importPreview", input.threadId),
              settings: serverSettings.getSettings.pipe(
                Effect.mapError((cause) => memoryOperationError("documents.importPreview", cause)),
              ),
              conversation: agentController.readConversationMemory
                ? agentController
                    .readConversationMemory(input.threadId)
                    .pipe(
                      Effect.mapError((cause) =>
                        memoryOperationError("documents.importPreview", cause),
                      ),
                    )
                : Effect.fail(
                    memoryOperationError(
                      "documents.importPreview",
                      "Observational memory is unavailable.",
                    ),
                  ),
            }).pipe(
              Effect.flatMap(({ access, settings, conversation }) =>
                Effect.tryPromise({
                  try: () =>
                    previewBotMemoryImport({
                      store: botMemoryStore,
                      access,
                      threadId: input.threadId,
                      archive: input.archive,
                      currentConversation: conversation,
                      privateBotMemory: settings.memory.privateBotMemory,
                    }),
                  catch: (cause) => memoryOperationError("documents.importPreview", cause),
                }),
              ),
            ),
            { "rpc.aggregate": "memory" },
          ),

        [WS_METHODS.memoryImportApply]: (input) =>
          observeRpcEffect(
            WS_METHODS.memoryImportApply,
            Effect.all({
              access: resolveBotMemoryAccess("documents.importApply", input.threadId),
              settings: serverSettings.getSettings.pipe(
                Effect.mapError((cause) => memoryOperationError("documents.importApply", cause)),
                Effect.flatMap((settings) =>
                  settings.memory.enabled === false
                    ? Effect.fail(
                        memoryOperationError("documents.importApply", "Memory is turned off."),
                      )
                    : Effect.succeed(settings),
                ),
              ),
              conversation: agentController.readConversationMemory
                ? agentController
                    .readConversationMemory(input.threadId)
                    .pipe(
                      Effect.mapError((cause) =>
                        memoryOperationError("documents.importApply", cause),
                      ),
                    )
                : Effect.fail(
                    memoryOperationError(
                      "documents.importApply",
                      "Observational memory is unavailable.",
                    ),
                  ),
            }).pipe(
              Effect.flatMap(({ access, settings, conversation }) =>
                Effect.tryPromise({
                  try: () =>
                    applyBotMemoryImport({
                      store: botMemoryStore,
                      access,
                      threadId: input.threadId,
                      archive: input.archive,
                      currentConversation: conversation,
                      previewHash: input.previewHash,
                      privateBotMemory: settings.memory.privateBotMemory,
                      restoreConversation: (snapshot, expectedSnapshot) =>
                        agentController.restoreConversationMemory
                          ? Effect.runPromise(
                              agentController.restoreConversationMemory(
                                input.threadId,
                                snapshot,
                                expectedSnapshot,
                              ),
                            )
                          : Promise.reject(
                              new Error("Observational memory restoration is unavailable."),
                            ),
                    }),
                  catch: (cause) => memoryOperationError("documents.importApply", cause),
                }),
              ),
            ),
            { "rpc.aggregate": "memory" },
          ),

        [WS_METHODS.memoryArchiveExport]: (input) =>
          observeRpcEffect(
            WS_METHODS.memoryArchiveExport,
            entityMemoryRepository === null
              ? Effect.fail(
                  memoryOperationError("archive.export", "Durable memory is unavailable."),
                )
              : Effect.all({
                  access: resolveMemoryAccess("archive.export", input.threadId),
                  conversations: resolveMemoryAccess("archive.export", input.threadId).pipe(
                    Effect.flatMap((access) => readArchiveConversations(access, input.target)),
                  ),
                  createdAt: nowIso,
                }).pipe(
                  Effect.flatMap(({ access, conversations, createdAt }) =>
                    exportAkeruMemory({
                      repository: entityMemoryRepository,
                      access,
                      target: input.target,
                      complete: input.complete && conversations.length > 0,
                      createdAt,
                      conversations,
                    }).pipe(
                      Effect.mapError((cause) => memoryOperationError("archive.export", cause)),
                    ),
                  ),
                ),
            { "rpc.aggregate": "memory" },
          ),

        [WS_METHODS.memoryArchivePreviewImport]: (input) =>
          observeRpcEffect(
            WS_METHODS.memoryArchivePreviewImport,
            entityMemoryRepository === null
              ? Effect.fail(
                  memoryOperationError("archive.previewImport", "Durable memory is unavailable."),
                )
              : resolveMemoryAccess("archive.previewImport", input.threadId).pipe(
                  Effect.flatMap((access) =>
                    previewAkeruMemoryImport({
                      repository: entityMemoryRepository,
                      access,
                      target: input.target,
                      archive: input.archive,
                    }).pipe(
                      Effect.mapError((cause) =>
                        memoryOperationError("archive.previewImport", cause),
                      ),
                    ),
                  ),
                ),
            { "rpc.aggregate": "memory" },
          ),

        [WS_METHODS.memoryArchiveApplyImport]: (input) =>
          observeRpcEffect(
            WS_METHODS.memoryArchiveApplyImport,
            entityMemoryRepository === null
              ? Effect.fail(
                  memoryOperationError("archive.applyImport", "Durable memory is unavailable."),
                )
              : serverSettings.getSettings.pipe(
                  Effect.mapError((cause) => memoryOperationError("archive.applyImport", cause)),
                  Effect.flatMap((settings) =>
                    settings.memory.enabled === false
                      ? Effect.fail(
                          memoryOperationError("archive.applyImport", "Memory is turned off."),
                        )
                      : resolveMemoryAccess("archive.applyImport", input.threadId),
                  ),
                  Effect.flatMap((access) =>
                    applyAkeruMemoryImport({
                      repository: entityMemoryRepository,
                      access,
                      target: input.target,
                      archive: input.archive,
                      previewHash: input.previewHash,
                      resolutions: input.resolutions,
                    }).pipe(
                      Effect.mapError((cause) =>
                        memoryOperationError("archive.applyImport", cause),
                      ),
                    ),
                  ),
                ),
            { "rpc.aggregate": "memory" },
          ),

        [WS_METHODS.memoryFactsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.memoryFactsList,
            entityMemoryRepository === null
              ? Effect.fail(memoryOperationError("facts.list", "Durable memory is unavailable."))
              : resolveMemoryAccess("facts.list", input.threadId).pipe(
                  Effect.flatMap((access) =>
                    exportAkeruMemory({
                      repository: entityMemoryRepository,
                      access,
                      target: input.target,
                      // Complete history, so pending, rejected, and forgotten facts stay
                      // visible and actionable, and each fact can show the text it replaced.
                      complete: true,
                      createdAt: "1970-01-01T00:00:00.000Z",
                      conversations: [],
                    }).pipe(
                      Effect.mapError((cause) => memoryOperationError("facts.list", cause)),
                      Effect.map((archive) => {
                        const revisions = archive.revisions.map(({ revision }) => revision);
                        const byId = new Map(revisions.map((revision) => [revision.id, revision]));
                        const firstCreatedAt = new Map<string, string>();
                        for (const revision of revisions) {
                          if (revision.revision === 1) {
                            firstCreatedAt.set(revision.rootId, revision.createdAt);
                          }
                        }
                        return {
                          facts: revisions
                            .filter(
                              (revision) =>
                                revision.supersededById === null &&
                                revision.deletionState !== "deleted",
                            )
                            .map((revision) => {
                              const previous = revision.supersedesId
                                ? byId.get(revision.supersedesId)
                                : undefined;
                              return {
                                rootId: revision.rootId,
                                fact: revision.fact,
                                scope: revision.partition.scope,
                                sourceThreadId: revision.sourceThreadId,
                                affectedBotIds: revision.affectedBotIds,
                                approvalState: revision.approvalState,
                                deletionState: revision.deletionState,
                                pinned: revision.pinned,
                                createdAt:
                                  firstCreatedAt.get(revision.rootId) ?? revision.createdAt,
                                updatedAt: revision.updatedAt,
                                revision: revision.revision,
                                supersededFact:
                                  previous && previous.fact !== revision.fact
                                    ? previous.fact
                                    : null,
                              };
                            }),
                        };
                      }),
                    ),
                  ),
                ),
            { "rpc.aggregate": "memory" },
          ),

        [WS_METHODS.memoryFactMutate]: (input) =>
          observeRpcEffect(
            WS_METHODS.memoryFactMutate,
            entityMemoryRepository === null
              ? Effect.fail(memoryOperationError("facts.mutate", "Durable memory is unavailable."))
              : Effect.all({
                  access: resolveMemoryAccess("facts.mutate", input.threadId),
                  memoryId: randomUUID.pipe(
                    Effect.map((uuid) => AkeruMemoryId.make(`rpc:${uuid}`)),
                  ),
                  updatedAt: nowIso,
                  settings: serverSettings.getSettings.pipe(
                    Effect.mapError((cause) => memoryOperationError("facts.mutate", cause)),
                  ),
                }).pipe(
                  Effect.flatMap(
                    ({
                      access,
                      memoryId,
                      updatedAt,
                      settings,
                    }): Effect.Effect<AkeruMemoryMutationResult, AkeruMemoryOperationError> => {
                      const mutation = input.mutation;
                      if (mutation.operation === "candidate.decide") {
                        const { decision } = mutation;
                        if (memoryApprovals === null) {
                          return Effect.fail(
                            memoryOperationError(
                              "facts.mutate",
                              "Memory approvals are unavailable.",
                            ),
                          );
                        }
                        if (decision.decision === "approve" && !settings.memory.enabled) {
                          return Effect.fail(
                            memoryOperationError("facts.mutate", "Memory is turned off."),
                          );
                        }
                        if (
                          decision.decision === "approve" &&
                          settings.memory.privateBotMemory === false &&
                          (decision.scope === "private" || decision.scope === "bot")
                        ) {
                          return Effect.fail(
                            memoryOperationError(
                              "facts.mutate",
                              "Private bot memory is turned off. The fact cannot be saved to a bot-private scope.",
                            ),
                          );
                        }
                        return memoryApprovals.decide({ access, decision }).pipe(
                          Effect.map((receipt) => ({ kind: "candidate" as const, receipt })),
                          Effect.mapError((cause) => memoryOperationError("facts.mutate", cause)),
                        );
                      }
                      if (mutation.operation === "conversation.clear") {
                        return Effect.fail(
                          memoryOperationError(
                            "facts.mutate",
                            `${mutation.operation} is not a durable fact mutation.`,
                          ),
                        );
                      }
                      if (settings.memory.enabled === false) {
                        return Effect.fail(
                          memoryOperationError("facts.mutate", "Memory is turned off."),
                        );
                      }
                      if (
                        settings.memory.privateBotMemory === false &&
                        mutation.operation === "fact.scope" &&
                        (mutation.scope === "private" || mutation.scope === "bot")
                      ) {
                        return Effect.fail(
                          memoryOperationError(
                            "facts.mutate",
                            "Private bot memory is turned off. The fact cannot be moved to a bot-private scope.",
                          ),
                        );
                      }
                      return entityMemoryRepository
                        .applyMutation({
                          access,
                          mutation,
                          memoryId,
                          updatedAt,
                          sharedProjectApproval:
                            settings.memory.sharedProjectMemory === "auto" ? "approved" : "pending",
                        })
                        .pipe(
                          Effect.map((revision) =>
                            revision === null
                              ? { kind: "deleted" as const, memoryId: mutation.memoryId }
                              : { kind: "revision" as const, revision },
                          ),
                          Effect.mapError((cause) => memoryOperationError("facts.mutate", cause)),
                        );
                    },
                  ),
                ),
            { "rpc.aggregate": "memory" },
          ).pipe(
            Effect.catch((cause) =>
              isOrchestrationDispatchCommandError(cause)
                ? memoryOperationError("facts.mutate", cause)
                : Effect.fail(cause),
            ),
          ),

        [WS_METHODS.memoryDocumentsInspect]: (input) =>
          observeRpcEffect(
            WS_METHODS.memoryDocumentsInspect,
            Effect.all({
              access: resolveBotMemoryAccess("documents.inspect", input.threadId),
              conversation: agentController.readConversationMemory
                ? agentController
                    .readConversationMemory(input.threadId)
                    .pipe(
                      Effect.mapError((cause) => memoryOperationError("documents.inspect", cause)),
                    )
                : Effect.fail(
                    memoryOperationError(
                      "documents.inspect",
                      "Observational memory is unavailable.",
                    ),
                  ),
            }).pipe(
              Effect.flatMap(({ access, conversation }) =>
                Effect.tryPromise({
                  try: () => botMemoryStore.readSnapshot(access),
                  catch: (cause) => memoryOperationError("documents.inspect", cause),
                }).pipe(Effect.map((documents) => ({ ...documents, conversation }))),
              ),
            ),
            { "rpc.aggregate": "memory" },
          ),

        [WS_METHODS.memoryDocumentReplace]: (input) =>
          observeRpcEffect(
            WS_METHODS.memoryDocumentReplace,
            Effect.all({
              access: resolveBotMemoryAccess("document.replace", input.threadId),
              settings: serverSettings.getSettings.pipe(
                Effect.mapError((cause) => memoryOperationError("document.replace", cause)),
              ),
            }).pipe(
              Effect.flatMap(({ access, settings }) =>
                settings.memory.enabled === false ||
                (input.target === "memory" && settings.memory.privateBotMemory === false)
                  ? Effect.fail(
                      memoryOperationError(
                        "document.replace",
                        input.target === "memory"
                          ? "Private bot memory is turned off."
                          : "Memory is turned off.",
                      ),
                    )
                  : Effect.tryPromise({
                      try: () =>
                        botMemoryStore.replaceDocument(
                          access,
                          input.target,
                          input.content,
                          input.expectedBotId,
                          input.expectedContent,
                        ),
                      catch: (cause) => memoryOperationError("document.replace", cause),
                    }),
              ),
            ),
            { "rpc.aggregate": "memory" },
          ),

        [WS_METHODS.memoryObservationsClear]: (input) =>
          observeRpcEffect(
            WS_METHODS.memoryObservationsClear,
            agentController.clearConversationMemory
              ? resolveMemoryAccess("observations.clear", input.threadId).pipe(
                  Effect.flatMap(() =>
                    (agentController.clearConversationMemory?.(input.threadId) ?? Effect.void).pipe(
                      Effect.mapError((cause) => memoryOperationError("observations.clear", cause)),
                    ),
                  ),
                )
              : Effect.fail(
                  memoryOperationError(
                    "observations.clear",
                    "Observational memory is unavailable.",
                  ),
                ),
            { "rpc.aggregate": "memory" },
          )
} satisfies Pick<RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>, typeof WS_METHODS.memoryExport | typeof WS_METHODS.memoryImportPreview | typeof WS_METHODS.memoryImportApply | typeof WS_METHODS.memoryArchiveExport | typeof WS_METHODS.memoryArchivePreviewImport | typeof WS_METHODS.memoryArchiveApplyImport | typeof WS_METHODS.memoryFactsList | typeof WS_METHODS.memoryFactMutate | typeof WS_METHODS.memoryDocumentsInspect | typeof WS_METHODS.memoryDocumentReplace | typeof WS_METHODS.memoryObservationsClear>);
