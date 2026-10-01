// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as Predicate from "effect/Predicate";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryPartitionId,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  type AkeruMemoryRevision,
  type AkeruMemoryThreadAccess,
  BotId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeDefaultOrchestrationThreadShell } from "./serverTestFixtures.ts";
import { buildAppUnderTest } from "./serverTestApp.ts";
import { getWsServerUrl, withWsRpcClient } from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("memory settings gate durable facts reads, writes, and bot-private scope", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-facts-gated");
      const threadId = ThreadId.make("thread-facts-gated");
      const botId = BotId.make("bot-facts-gated");
      const now = "2026-01-01T00:00:00.000Z";
      const tenantId = AkeruMemoryTenantId.make("local");
      const userId = AkeruMemoryUserId.make("owner");
      const workspaceRoot = "/workspace/facts-gated";

      const project = {
        id: projectId,
        title: "Gated facts",
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
        fact: `Gated durable fact ${id}`,
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

      const threadFact = revision("gated-thread-fact", "thread");
      const botFact = revision("gated-bot-fact", "bot");

      const settingsRef = { current: { ...DEFAULT_SERVER_SETTINGS.memory } };
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
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                bots: [],
                groups: [],
                delegations: [],
                projects: [],
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
          serverSettings: {
            getSettings: Effect.sync(() => ({
              ...DEFAULT_SERVER_SETTINGS,
              memory: settingsRef.current,
            })),
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");

      const listFacts = (target: "thread" | "bot") =>
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryFactsList]({ threadId, target }),
          ),
        ).pipe(Effect.map((result) => result.facts.map((fact) => fact.rootId).sort()));

      const moveToBot = (memoryId: string, expectedRevision: number) =>
        Effect.flip(
          Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[WS_METHODS.memoryFactMutate]({
                threadId,
                mutation: {
                  operation: "fact.scope",
                  memoryId: AkeruMemoryRootId.make(memoryId),
                  expectedRevision,
                  scope: "bot",
                },
              }),
            ),
          ),
        );

      const threadArchive = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryArchiveExport]({ threadId, target: "thread", complete: true }),
        ),
      );

      // With "Private bot memory" off, existing bot-private facts are still
      // listed so the user can clean them up, but facts cannot be moved into a
      // bot-private scope.
      settingsRef.current = { ...DEFAULT_SERVER_SETTINGS.memory, privateBotMemory: false };
      assert.deepEqual(yield* listFacts("bot"), [botFact.rootId]);
      assert.deepEqual(yield* listFacts("thread"), [threadFact.rootId]);
      const deniedPrivate = yield* moveToBot(threadFact.rootId, 1);
      assert.equal(deniedPrivate._tag, "AkeruMemoryOperationError");

      // Cleanup actions on existing bot-private facts still work.
      const forgotten = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryFactMutate]({
            threadId,
            mutation: {
              operation: "fact.forget",
              memoryId: botFact.rootId,
              expectedRevision: 1,
            },
          }),
        ),
      );

      if (forgotten.kind !== "revision") return assert.fail("expected a revision result");
      assert.equal(forgotten.revision.deletionState, "tombstoned");

      const deleted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryFactMutate]({
            threadId,
            mutation: {
              operation: "fact.delete",
              memoryId: botFact.rootId,
              expectedRevision: 2,
            },
          }),
        ),
      );

      assert.deepEqual(deleted, { kind: "deleted", memoryId: botFact.rootId });
      assert.deepEqual(yield* listFacts("bot"), []);

      // The bot-private Markdown document is no longer writable through the
      // memory screen either, while the user document stays editable.
      const privateDocError = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryDocumentReplace]({
              threadId,
              target: "memory",
              expectedBotId: botId,
              expectedContent: "",
              content: "bot-private note",
            }),
          ),
        ),
      );

      assert.equal(privateDocError._tag, "AkeruMemoryOperationError");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryDocumentReplace]({
            threadId,
            target: "user",
            expectedBotId: botId,
            expectedContent: "",
            content: "user note stays writable",
          }),
        ),
      );

      // With durable memory off entirely, mutations are rejected but reads
      // still return existing facts.
      settingsRef.current = { ...DEFAULT_SERVER_SETTINGS.memory, enabled: false };
      assert.deepEqual(yield* listFacts("thread"), [threadFact.rootId]);

      const deniedEdit = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryFactMutate]({
              threadId,
              mutation: {
                operation: "fact.edit",
                memoryId: threadFact.rootId,
                expectedRevision: 1,
                fact: "updated while disabled",
              },
            }),
          ),
        ),
      );

      assert.equal(deniedEdit._tag, "AkeruMemoryOperationError");

      const deniedUserDoc = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryDocumentReplace]({
              threadId,
              target: "user",
              expectedBotId: botId,
              expectedContent: "user note stays writable",
              content: "another note",
            }),
          ),
        ),
      );

      assert.equal(deniedUserDoc._tag, "AkeruMemoryOperationError");

      // Archive imports can still be previewed, but applying one is rejected
      // and leaves the facts untouched.
      const disabledPreview = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryArchivePreviewImport]({
            threadId,
            target: "thread",
            archive: threadArchive,
          }),
        ),
      );

      const deniedImport = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryArchiveApplyImport]({
              threadId,
              target: "thread",
              archive: threadArchive,
              previewHash: disabledPreview.previewHash,
              resolutions: [],
            }),
          ),
        ),
      );

      if (!Predicate.isTagged(deniedImport, "AkeruMemoryOperationError")) {
        return assert.fail("expected a memory operation error");
      }

      assert.include(deniedImport.detail, "Memory is turned off.");
      assert.deepEqual(yield* listFacts("thread"), [threadFact.rootId]);

      // Archive import is a write too, so it is rejected while memory is off.
      const deniedDurableImport = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryImportApply]({
              threadId,
              previewHash: "0".repeat(64),
              archive: {
                schemaVersion: 3,
                anchorThreadId: threadId,
                botId,
                groupId: null,
                createdAt: now,
                documents: [],
                conversation: {
                  snapshot: { current: null, history: [] },
                  sha256: "0".repeat(64),
                },
                manifestSha256: "0".repeat(64),
              },
            }),
          ),
        ),
      );

      if (!Predicate.isTagged(deniedDurableImport, "AkeruMemoryOperationError"))
        return assert.fail("expected a memory error");
      assert.equal(deniedDurableImport.detail, "Memory is turned off.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
