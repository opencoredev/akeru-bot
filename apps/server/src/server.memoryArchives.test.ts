// @effect-diagnostics globalDate:off nodeBuiltinImport:off
// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryPartitionId,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  type AkeruMemoryArchiveV2,
  type AkeruMemoryRevision,
  type AkeruMemoryThreadAccess,
  BotId,
  MessageId,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type EntityMemoryRepositoryShape } from "./memory/Services/EntityMemoryRepository.ts";
import { encodeMemoryArchiveJson } from "./memory/MemoryArchiveJson.ts";
import { memoryRevisionArchivePath, renderMemoryRevision } from "./memory/MemoryExport.ts";

import { buildAppUnderTest } from "./serverTestApp.ts";
import {
  getWsServerUrl,
  withWsRpcClient,
  exchangeAccessToken,
  fetchEffect,
  getHttpServerUrl,
  responseJsonEffect,
} from "./serverTestClients.ts";
import {
  defaultDesktopBootstrapToken,
  makeDefaultOrchestrationThreadShell,
} from "./serverTestFixtures.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("routes durable memory archive RPCs through thread authorization", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const threadId = ThreadId.make("missing-memory-thread");

      const exportError = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryArchiveExport]({
              threadId,
              target: "thread",
              complete: true,
            }),
          ),
        ),
      );

      assert.equal(exportError._tag, "AkeruMemoryOperationError");

      const invalidArchive = {
        schemaVersion: 2,
        anchorThreadId: threadId,
        target: "thread",
        complete: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        files: [],
        revisions: [],
        conversations: [],
        manifestSha256: "0".repeat(64),
      } as never;

      const previewError = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryArchivePreviewImport]({
              threadId,
              target: "thread",
              archive: invalidArchive,
            }),
          ),
        ),
      );

      assert.equal(previewError._tag, "AkeruMemoryOperationError");

      const applyError = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryArchiveApplyImport]({
              threadId,
              target: "thread",
              archive: invalidArchive,
              previewHash: "0".repeat(64),
              resolutions: [],
            }),
          ),
        ),
      );

      assert.equal(applyError._tag, "AkeruMemoryOperationError");

      // Existing V3 memory.documents.* methods remain available while T17
      // migrates the client to the durable archive RPCs.
      const v3Error = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryDocumentsInspect]({ threadId }),
          ),
        ),
      );

      assert.equal(v3Error._tag, "AkeruMemoryOperationError");

      // A read-scoped token can export and preview, while apply requires the
      // operate scope declared by RpcAuthorization.
      const readToken = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:read",
      });

      assert.equal(readToken.response.status, 200);

      const ticketResponse = yield* fetchEffect(
        yield* getHttpServerUrl("/api/auth/websocket-ticket"),
        {
          method: "POST",
          headers: { authorization: `Bearer ${readToken.body.access_token ?? ""}` },
        },
      );

      const ticketBody = yield* responseJsonEffect<{ readonly ticket: string }>(ticketResponse);
      const readWsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(ticketBody.ticket)}`;

      const deniedApply = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(readWsUrl, (client) =>
            client[WS_METHODS.memoryArchiveApplyImport]({
              threadId,
              target: "thread",
              archive: invalidArchive,
              previewHash: "0".repeat(64),
              resolutions: [],
            }),
          ),
        ),
      );

      assert.equal(deniedApply._tag, "EnvironmentAuthorizationError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("durable memory archives export, preview, and apply over WS", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-memory-archive");
      const foreignProjectId = ProjectId.make("project-memory-other");
      const threadId = ThreadId.make("thread-memory-archive");
      const botId = BotId.make("bot-memory-archive");
      const foreignBotId = BotId.make("bot-memory-other");
      const foreignThreadId = ThreadId.make("thread-memory-other");
      const now = "2026-01-01T00:00:00.000Z";
      const tenantId = AkeruMemoryTenantId.make("local");
      const userId = AkeruMemoryUserId.make("owner");
      const workspaceRoot = "/workspace/memory-archive";
      let repositoryRef: EntityMemoryRepositoryShape | undefined;

      const projectShell = (id: ProjectId) => ({
        id,
        title: `Project ${id}`,
        workspaceRoot,
        repositoryIdentity: null,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        faviconPath: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      });

      const access = (
        overrides: Partial<AkeruMemoryThreadAccess> = {},
      ): AkeruMemoryThreadAccess => ({
        tenantId,
        userId,
        threadId,
        projectId,
        workspaceRoot,
        legacyWorkspaceOwnerProjectId: projectId,
        botId,
        groupId: null,
        respondingBotId: null,
        groupMemberBotIds: [],
        ...overrides,
      });

      const threadRevision = (
        id: string,
        overrides: Partial<AkeruMemoryRevision> = {},
      ): AkeruMemoryRevision => ({
        id: AkeruMemoryId.make(id),
        rootId: AkeruMemoryRootId.make(id),
        revision: 1,
        partition: {
          tenantId,
          scope: "thread",
          partitionId: AkeruMemoryPartitionId.make(threadId),
        },
        entityKind: "bot",
        entityId: AkeruMemoryEntityId.make(botId),
        kind: "fact",
        value: { marker: id },
        fact: `WS durable memory marker ${id}`,
        sourceThreadId: threadId,
        sourceMessageId: MessageId.make(`message-${id}`),
        authorBotId: botId,
        initiatingUserId: userId,
        createdAt: now,
        confirmedAt: now,
        updatedAt: now,
        confidence: 0.9,
        approvalState: "approved",
        supersedesId: null,
        supersededById: null,
        visibility: "private",
        deletionState: "active",
        pinned: false,
        sensitive: false,
        affectedBotIds: [botId],
        ...overrides,
      });

      const botRevision = threadRevision("ws-archive-bot-memory", {
        partition: {
          tenantId,
          scope: "bot",
          partitionId: AkeruMemoryPartitionId.make(botId),
        },
        entityKind: "bot",
        sourceThreadId: null,
      });

      const seededThreadRevision = threadRevision("ws-archive-thread-memory");

      yield* buildAppUnderTest({
        durableMemory: {
          seed: (repository) =>
            Effect.gen(function* () {
              repositoryRef = repository;
              yield* repository.insert({ access: access(), revision: seededThreadRevision });
              yield* repository.insert({ access: access(), revision: botRevision });
            }),
        },
        layers: {
          agentController: {
            readConversationMemory: () => Effect.succeed({ current: null, history: [] }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                bots: [],
                groups: [],
                delegations: [],
                projects: [projectShell(projectId)],
                threads: [
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    projectId,
                    botId,
                    respondingBotId: null,
                  }),
                ],
                updatedAt: now,
              }),
            getProjectShellById: (id) =>
              Effect.succeed(
                id === projectId || id === foreignProjectId
                  ? Option.some(projectShell(id))
                  : Option.none(),
              ),
            getOriginalProjectIdByWorkspaceRoot: (root) =>
              Effect.succeed(root === workspaceRoot ? Option.some(projectId) : Option.none()),
            getThreadShellById: (id) =>
              Effect.succeed(
                id === threadId
                  ? Option.some(
                      makeDefaultOrchestrationThreadShell({
                        id: threadId,
                        projectId,
                        botId,
                        respondingBotId: null,
                      }),
                    )
                  : Option.none(),
              ),
          },
        },
      });
      assert.isDefined(repositoryRef);
      const repository = repositoryRef!;

      // A read-scoped token can export and preview, while apply requires the
      // operate scope declared by RpcAuthorization.
      const readToken = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:read",
      });

      assert.equal(readToken.response.status, 200);

      const ticketResponse = yield* fetchEffect(
        yield* getHttpServerUrl("/api/auth/websocket-ticket"),
        {
          method: "POST",
          headers: { authorization: `Bearer ${readToken.body.access_token ?? ""}` },
        },
      );

      const ticketBody = yield* responseJsonEffect<{ readonly ticket: string }>(ticketResponse);
      const readWsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(ticketBody.ticket)}`;
      const wsUrl = yield* getWsServerUrl("/ws");

      const archive = yield* Effect.scoped(
        withWsRpcClient(readWsUrl, (client) =>
          client[WS_METHODS.memoryArchiveExport]({
            threadId,
            target: "thread",
            complete: true,
          }),
        ),
      );

      assert.equal(archive.schemaVersion, 2);
      assert.equal(archive.anchorThreadId, threadId);
      assert.equal(archive.target, "thread");
      assert.deepEqual(
        archive.revisions.map(({ revision }) => revision.id),
        [seededThreadRevision.id],
      );
      assert.equal(archive.files.length, 1);
      assert.include(archive.files[0]?.content ?? "", seededThreadRevision.fact);

      // Every target returns only its own partitions.
      const exportIds = (target: "thread" | "bot" | "project" | "all") =>
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryArchiveExport]({ threadId, target, complete: true }),
          ),
        ).pipe(Effect.map((result) => result.revisions.map(({ revision }) => revision.id).sort()));

      assert.deepEqual(yield* exportIds("thread"), [seededThreadRevision.id]);
      assert.deepEqual(yield* exportIds("bot"), [botRevision.id]);
      assert.deepEqual(yield* exportIds("project"), []);
      assert.deepEqual(yield* exportIds("all"), [botRevision.id, seededThreadRevision.id].sort());

      const preview = yield* Effect.scoped(
        withWsRpcClient(readWsUrl, (client) =>
          client[WS_METHODS.memoryArchivePreviewImport]({
            threadId,
            target: "thread",
            archive,
          }),
        ),
      );

      assert.deepEqual(
        preview.items.map((item) => item.classification),
        ["skipped"],
      );

      // Diverge the local history so applying the archive is observable.
      const divergentRevision = threadRevision("ws-archive-thread-memory-divergent", {
        rootId: seededThreadRevision.rootId,
        revision: 2,
        supersedesId: seededThreadRevision.id,
        fact: "WS durable memory diverged fact",
      });

      yield* repository.revise({
        access: access(),
        revision: divergentRevision,
        expectedRevision: 1,
      });

      const conflictedPreview = yield* Effect.scoped(
        withWsRpcClient(readWsUrl, (client) =>
          client[WS_METHODS.memoryArchivePreviewImport]({
            threadId,
            target: "thread",
            archive,
          }),
        ),
      );

      assert.deepEqual(
        conflictedPreview.items.map((item) => item.classification),
        ["conflicting"],
      );

      const deniedApply = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(readWsUrl, (client) =>
            client[WS_METHODS.memoryArchiveApplyImport]({
              threadId,
              target: "thread",
              archive,
              previewHash: conflictedPreview.previewHash,
              resolutions: [{ rootId: seededThreadRevision.rootId, decision: "use-archive" }],
            }),
          ),
        ),
      );

      assert.equal(deniedApply._tag, "EnvironmentAuthorizationError");

      const applyResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryArchiveApplyImport]({
            threadId,
            target: "thread",
            archive,
            previewHash: conflictedPreview.previewHash,
            resolutions: [{ rootId: seededThreadRevision.rootId, decision: "use-archive" }],
          }),
        ),
      );

      // The one conflicting root was resolved with use-archive, so nothing is
      // counted as new, changed, or skipped.
      assert.deepEqual(applyResult, { imported: 0, changed: 0, skipped: 0 });

      const restored = yield* repository.getCurrent({
        access: access(),
        rootId: seededThreadRevision.rootId,
      });

      assert.equal(restored.id, seededThreadRevision.id);
      assert.equal(restored.fact, seededThreadRevision.fact);

      // Ownership mismatches: a foreign anchor thread, a foreign bot author,
      // and a foreign project partition must each be rejected. Each forged
      // archive keeps a valid manifest so the failure is authorization, not a
      // checksum error.
      const forgeArchive = (
        overrides: Partial<AkeruMemoryArchiveV2>,
        revisionPatch?: (revision: AkeruMemoryRevision) => AkeruMemoryRevision,
      ): AkeruMemoryArchiveV2 => {
        const revisions = archive.revisions.map(({ revision }) => {
          const next = revisionPatch ? revisionPatch(revision) : revision;

          return {
            revision: next,
            sha256: NodeCrypto.createHash("sha256")
              .update(encodeMemoryArchiveJson(next))
              .digest("hex"),
          };
        });

        const files = revisions.map(({ revision }) => {
          const content = renderMemoryRevision(revision);

          return {
            path: memoryRevisionArchivePath(revision),
            mediaType: "text/markdown" as const,
            sha256: NodeCrypto.createHash("sha256").update(content).digest("hex"),
            content,
          };
        });

        const conversations = archive.conversations;

        const manifest = encodeMemoryArchiveJson({
          schemaVersion: 2,
          anchorThreadId: overrides.anchorThreadId ?? archive.anchorThreadId,
          target: archive.target,
          complete: archive.complete,
          createdAt: archive.createdAt,
          files: files.map(({ path, sha256 }) => ({ path, sha256 })),
          revisions: revisions.map(({ revision, sha256 }) => ({
            id: revision.id,
            rootId: revision.rootId,
            revision: revision.revision,
            sha256,
          })),
          conversations: conversations.map(({ threadId, sha256 }) => ({
            threadId,
            sha256,
          })),
        });

        return {
          ...archive,
          ...overrides,
          files,
          revisions,
          manifestSha256: NodeCrypto.createHash("sha256").update(manifest).digest("hex"),
        };
      };

      const mismatchedArchives: ReadonlyArray<AkeruMemoryArchiveV2> = [
        forgeArchive({ anchorThreadId: foreignThreadId }, (revision) => ({
          ...revision,
          partition: {
            ...revision.partition,
            partitionId: AkeruMemoryPartitionId.make(foreignThreadId),
          },
          sourceThreadId: foreignThreadId,
        })),
        forgeArchive({}, (revision) => ({ ...revision, authorBotId: foreignBotId })),
        forgeArchive({}, (revision) => ({
          ...revision,
          partition: {
            ...revision.partition,
            partitionId: AkeruMemoryPartitionId.make(foreignProjectId),
          },
          entityKind: "project" as const,
          entityId: AkeruMemoryEntityId.make(foreignProjectId),
        })),
      ];

      for (const candidate of mismatchedArchives) {
        const previewError = yield* Effect.flip(
          Effect.scoped(
            withWsRpcClient(readWsUrl, (client) =>
              client[WS_METHODS.memoryArchivePreviewImport]({
                threadId,
                target: "thread",
                archive: candidate,
              }),
            ),
          ),
        );

        assert.equal(previewError._tag, "AkeruMemoryOperationError");
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("clearing chat observations leaves durable facts and the bot intact", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-memory-clear");
      const threadId = ThreadId.make("thread-memory-clear");
      const botId = BotId.make("bot-memory-clear");
      const now = "2026-01-01T00:00:00.000Z";
      const tenantId = AkeruMemoryTenantId.make("local");
      const userId = AkeruMemoryUserId.make("owner");
      const workspaceRoot = "/workspace/memory-clear";
      const cleared: Array<ThreadId> = [];
      const botWrites: Array<string> = [];
      let dispatches = 0;

      const project = {
        id: projectId,
        title: "Memory clear",
        workspaceRoot,
        repositoryIdentity: null,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        faviconPath: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      };

      const thread = makeDefaultOrchestrationThreadShell({
        id: threadId,
        projectId,
        botId,
        respondingBotId: null,
      });

      const access: AkeruMemoryThreadAccess = {
        tenantId,
        userId,
        threadId,
        projectId,
        workspaceRoot,
        legacyWorkspaceOwnerProjectId: projectId,
        botId,
        groupId: null,
        respondingBotId: null,
        groupMemberBotIds: [],
      };

      const revision = (id: string, scope: "thread" | "bot"): AkeruMemoryRevision => ({
        id: AkeruMemoryId.make(id),
        rootId: AkeruMemoryRootId.make(id),
        revision: 1,
        partition: {
          tenantId,
          scope,
          partitionId: AkeruMemoryPartitionId.make(scope === "thread" ? threadId : botId),
        },
        entityKind: "bot",
        entityId: AkeruMemoryEntityId.make(botId),
        kind: "fact",
        value: {},
        fact: `Durable fact ${id}`,
        sourceThreadId: scope === "thread" ? threadId : null,
        sourceMessageId: null,
        authorBotId: botId,
        initiatingUserId: userId,
        createdAt: now,
        confirmedAt: now,
        updatedAt: now,
        confidence: 0.9,
        approvalState: "approved",
        supersedesId: null,
        supersededById: null,
        visibility: "private",
        deletionState: "active",
        pinned: false,
        sensitive: false,
        affectedBotIds: [botId],
      });

      const threadFact = revision("clear-thread-fact", "thread");
      const botFact = revision("clear-bot-fact", "bot");

      yield* buildAppUnderTest({
        durableMemory: {
          seed: (repository) =>
            Effect.gen(function* () {
              yield* repository.insert({ access, revision: threadFact });
              yield* repository.insert({ access, revision: botFact });
            }),
        },
        layers: {
          agentController: {
            readConversationMemory: () => Effect.succeed({ current: null, history: [] }),
            clearConversationMemory: (id) => Effect.sync(() => void cleared.push(id)),
          },
          orchestrationEngine: {
            dispatch: () =>
              Effect.sync(() => {
                dispatches += 1;

                return { sequence: 1 };
              }),
          },
          projectionBots: {
            upsert: (bot) => Effect.sync(() => void botWrites.push(bot.botId)),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                bots: [],
                groups: [],
                delegations: [],
                projects: [project],
                threads: [thread],
                updatedAt: now,
              }),
            getProjectShellById: (id) =>
              Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
            getOriginalProjectIdByWorkspaceRoot: (root) =>
              Effect.succeed(root === workspaceRoot ? Option.some(projectId) : Option.none()),
            getThreadShellById: (id) =>
              Effect.succeed(id === threadId ? Option.some(thread) : Option.none()),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const exportFacts = (target: "thread" | "bot") =>
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryArchiveExport]({ threadId, target, complete: true }),
          ),
        ).pipe(Effect.map((archive) => archive.revisions.map(({ revision }) => revision.fact)));

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryObservationsClear]({ threadId }),
        ),
      );

      assert.deepEqual(cleared, [threadId]);
      assert.deepEqual(yield* exportFacts("thread"), [threadFact.fact]);
      assert.deepEqual(yield* exportFacts("bot"), [botFact.fact]);
      assert.deepEqual(botWrites, []);
      assert.equal(dispatches, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
