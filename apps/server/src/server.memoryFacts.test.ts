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
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type EntityMemoryRepositoryShape } from "./memory/Services/EntityMemoryRepository.ts";

import {
  makeDefaultOrchestrationThreadShell,
  defaultDesktopBootstrapToken,
} from "./serverTestFixtures.ts";
import { buildAppUnderTest } from "./serverTestApp.ts";
import {
  exchangeAccessToken,
  fetchEffect,
  getHttpServerUrl,
  responseJsonEffect,
  getWsServerUrl,
  withWsRpcClient,
} from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("memory.facts.list returns current durable facts without chat snapshots", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-facts-list");
      const threadId = ThreadId.make("thread-facts-list");
      const botId = BotId.make("bot-facts-list");
      const now = "2026-01-01T00:00:00.000Z";
      const tenantId = AkeruMemoryTenantId.make("local");
      const userId = AkeruMemoryUserId.make("owner");
      const workspaceRoot = "/workspace/facts-list";

      const project = {
        id: projectId,
        title: "Facts list",
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

      const revision = (id: string): AkeruMemoryRevision => ({
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
        value: {},
        fact: `Listed durable fact ${id}`,
        sourceThreadId: threadId,
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

      yield* buildAppUnderTest({
        durableMemory: {
          seed: (repository) =>
            Effect.gen(function* () {
              yield* repository.insert({ access, revision: revision("list-fact-a") });
              yield* repository.insert({ access, revision: revision("list-fact-b") });
              // Rejected, forgotten, and edited facts stay listed at their current revision so
              // the user can act on them.
              yield* repository.insert({ access, revision: revision("list-fact-rejected") });
              yield* repository.insert({ access, revision: revision("list-fact-forgotten") });
              yield* repository.applyMutation({
                access,
                mutation: {
                  operation: "fact.decide",
                  memoryId: AkeruMemoryRootId.make("list-fact-rejected"),
                  expectedRevision: 1,
                  decision: "reject",
                },
                memoryId: AkeruMemoryId.make("list-fact-rejected-2"),
                updatedAt: now,
                sharedProjectApproval: "pending",
              });
              yield* repository.applyMutation({
                access,
                mutation: {
                  operation: "fact.forget",
                  memoryId: AkeruMemoryRootId.make("list-fact-forgotten"),
                  expectedRevision: 1,
                },
                memoryId: AkeruMemoryId.make("list-fact-forgotten-2"),
                updatedAt: now,
                sharedProjectApproval: "pending",
              });
              yield* repository.applyMutation({
                access,
                mutation: {
                  operation: "fact.edit",
                  memoryId: AkeruMemoryRootId.make("list-fact-a"),
                  expectedRevision: 1,
                  fact: "Edited durable fact list-fact-a",
                },
                memoryId: AkeruMemoryId.make("list-fact-a-2"),
                updatedAt: now,
                sharedProjectApproval: "pending",
              });
            }),
        },
        layers: {
          projectionSnapshotQuery: {
            getProjectShellById: (id) =>
              Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
            getOriginalProjectIdByWorkspaceRoot: (root) =>
              Effect.succeed(root === workspaceRoot ? Option.some(projectId) : Option.none()),
            getThreadShellById: (id) =>
              Effect.succeed(id === threadId ? Option.some(thread) : Option.none()),
          },
        },
      });

      // A read-scoped token is enough to list durable facts.
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

      const listed = yield* Effect.scoped(
        withWsRpcClient(readWsUrl, (client) =>
          client[WS_METHODS.memoryFactsList]({ threadId, target: "thread" }),
        ),
      );

      assert.deepEqual(
        listed.facts
          .map((fact) => `${fact.rootId}:${fact.approvalState}:${fact.deletionState}`)
          .sort(),
        [
          "list-fact-a:approved:active",
          "list-fact-b:approved:active",
          "list-fact-forgotten:approved:tombstoned",
          "list-fact-rejected:rejected:active",
        ],
      );
      const edited = listed.facts.find((fact) => fact.rootId === "list-fact-a");
      assert.equal(edited?.fact, "Edited durable fact list-fact-a");
      assert.equal(edited?.supersededFact, "Listed durable fact list-fact-a");
      assert.equal(edited?.revision, 2);
      // The read shape carries only fact metadata: no conversation or
      // observational-memory payloads may cross the wire.
      assert.deepEqual(Object.keys(listed).sort(), ["facts"]);
      assert.isFalse("conversation" in listed);
      assert.isFalse("observations" in listed);
      assert.isFalse("snapshot" in listed);

      const foreign = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(readWsUrl, (client) =>
            client[WS_METHODS.memoryFactsList]({
              threadId: ThreadId.make("thread-facts-missing"),
              target: "thread",
            }),
          ),
        ),
      );

      assert.equal(foreign._tag, "AkeruMemoryOperationError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("memory.facts.mutate mutates durable facts with operate scope and ownership", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-facts-mutate");
      const foreignProjectId = ProjectId.make("project-facts-other");
      const threadId = ThreadId.make("thread-facts-mutate");
      const botId = BotId.make("bot-facts-mutate");
      const foreignBotId = BotId.make("bot-facts-other");
      const now = "2026-01-01T00:00:00.000Z";
      const tenantId = AkeruMemoryTenantId.make("local");
      const userId = AkeruMemoryUserId.make("owner");
      const workspaceRoot = "/workspace/facts-mutate";
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

      const revision = (id: string): AkeruMemoryRevision => ({
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
        value: {},
        fact: `Mutable durable fact ${id}`,
        sourceThreadId: threadId,
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

      const seeded = revision("mutate-fact-1");

      yield* buildAppUnderTest({
        durableMemory: {
          seed: (repository) =>
            Effect.gen(function* () {
              repositoryRef = repository;
              yield* repository.insert({ access, revision: seeded });
            }),
        },
        layers: {
          projectionSnapshotQuery: {
            getProjectShellById: (id) =>
              Effect.succeed(
                id === projectId || id === foreignProjectId
                  ? Option.some(projectShell(id))
                  : Option.none(),
              ),
            getOriginalProjectIdByWorkspaceRoot: (root) =>
              Effect.succeed(root === workspaceRoot ? Option.some(projectId) : Option.none()),
            getThreadShellById: (id) =>
              Effect.succeed(id === threadId ? Option.some(thread) : Option.none()),
          },
        },
      });
      assert.isDefined(repositoryRef);
      const repository = repositoryRef!;
      const wsUrl = yield* getWsServerUrl("/ws");

      // A read-scoped token cannot mutate durable facts.
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

      const denied = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(readWsUrl, (client) =>
            client[WS_METHODS.memoryFactMutate]({
              threadId,
              mutation: {
                operation: "fact.pin",
                memoryId: seeded.rootId,
                expectedRevision: 1,
                pinned: true,
              },
            }),
          ),
        ),
      );

      assert.equal(denied._tag, "EnvironmentAuthorizationError");

      const edited = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryFactMutate]({
            threadId,
            mutation: {
              operation: "fact.edit",
              memoryId: seeded.rootId,
              expectedRevision: 1,
              fact: "Edited over WS",
            },
          }),
        ),
      );

      assert.equal(edited.kind, "revision");

      if (edited.kind !== "revision") return assert.fail("expected a revision result");
      assert.equal(edited.revision.fact, "Edited over WS");
      assert.equal(edited.revision.revision, 2);

      const pinned = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryFactMutate]({
            threadId,
            mutation: {
              operation: "fact.pin",
              memoryId: seeded.rootId,
              expectedRevision: 2,
              pinned: true,
            },
          }),
        ),
      );

      if (pinned.kind !== "revision") return assert.fail("expected a revision result");
      assert.isTrue(pinned.revision.pinned);

      const forgotten = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryFactMutate]({
            threadId,
            mutation: {
              operation: "fact.forget",
              memoryId: seeded.rootId,
              expectedRevision: 3,
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
              memoryId: seeded.rootId,
              expectedRevision: 4,
            },
          }),
        ),
      );

      assert.equal(deleted.kind, "deleted");

      const missing = yield* repository
        .getCurrent({ access, rootId: seeded.rootId })
        .pipe(Effect.exit);

      assert.isTrue(Predicate.isTagged(missing, "Failure"));

      // A mutation against a thread that is not the owner is rejected before
      // any repository write.
      const wrongOwner = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.memoryFactMutate]({
              threadId: ThreadId.make("thread-facts-other"),
              mutation: {
                operation: "fact.pin",
                memoryId: seeded.rootId,
                expectedRevision: 1,
                pinned: true,
              },
            }),
          ),
        ),
      );

      assert.equal(wrongOwner._tag, "AkeruMemoryOperationError");
      assert.isDefined(foreignBotId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("shared project memory lands pending approval by default", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-facts-pending");
      const threadId = ThreadId.make("thread-facts-pending");
      const botId = BotId.make("bot-facts-pending");
      const now = "2026-01-01T00:00:00.000Z";
      const tenantId = AkeruMemoryTenantId.make("local");
      const userId = AkeruMemoryUserId.make("owner");
      const workspaceRoot = "/workspace/facts-pending";
      let repositoryRef: EntityMemoryRepositoryShape | undefined;

      const project = {
        id: projectId,
        title: "Pending defaults",
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

      const seeded: AkeruMemoryRevision = {
        id: AkeruMemoryId.make("pending-fact-1"),
        rootId: AkeruMemoryRootId.make("pending-fact-1"),
        revision: 1,
        partition: {
          tenantId,
          scope: "bot",
          partitionId: AkeruMemoryPartitionId.make(botId),
        },
        entityKind: "bot",
        entityId: AkeruMemoryEntityId.make(botId),
        kind: "fact",
        value: {},
        fact: "A private bot fact",
        sourceThreadId: null,
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
      };

      yield* buildAppUnderTest({
        durableMemory: {
          seed: (repository) =>
            Effect.gen(function* () {
              repositoryRef = repository;
              yield* repository.insert({ access, revision: seeded });
            }),
        },
        layers: {
          projectionSnapshotQuery: {
            getProjectShellById: (id) =>
              Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
            getOriginalProjectIdByWorkspaceRoot: (root) =>
              Effect.succeed(root === workspaceRoot ? Option.some(projectId) : Option.none()),
            getThreadShellById: (id) =>
              Effect.succeed(id === threadId ? Option.some(thread) : Option.none()),
          },
        },
      });
      assert.isDefined(repositoryRef);
      const repository = repositoryRef!;
      const wsUrl = yield* getWsServerUrl("/ws");

      // Default settings keep "Shared project memory" at ask-before-saving, so
      // moving a private fact onto the shared project scope lands it pending.
      const moved = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryFactMutate]({
            threadId,
            mutation: {
              operation: "fact.scope",
              memoryId: seeded.rootId,
              expectedRevision: 1,
              scope: "project",
            },
          }),
        ),
      );

      if (moved.kind !== "revision") return assert.fail("expected a revision result");
      assert.equal(moved.revision.partition.scope, "project");
      assert.equal(moved.revision.visibility, "shared");
      assert.equal(moved.revision.approvalState, "pending");

      // Pending facts are not part of current recall until approved.
      const current = yield* repository.listCurrent({ access });
      assert.isFalse(current.some((revision) => revision.rootId === seeded.rootId));

      const approved = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.memoryFactMutate]({
            threadId,
            mutation: {
              operation: "fact.decide",
              memoryId: seeded.rootId,
              expectedRevision: 2,
              decision: "approve",
            },
          }),
        ),
      );

      if (approved.kind !== "revision") return assert.fail("expected a revision result");
      assert.equal(approved.revision.approvalState, "approved");
      assert.isTrue(
        (yield* repository.listCurrent({ access })).some(
          (revision) => revision.rootId === seeded.rootId,
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
