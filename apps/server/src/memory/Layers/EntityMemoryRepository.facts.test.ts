import * as Predicate from "effect/Predicate";
import {
  repositoryLayer,
  makeRevision,
  privateAccess,
  botAccess,
  sharedAccess,
} from "./testUtils/entityMemoryRepository.ts";
import { assert, it } from "@effect/vitest";
import {
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryPartitionId,
  AkeruMemoryRootId,
  BotId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  EntityMemoryConflictError,
  EntityMemoryRepository,
} from "../Services/EntityMemoryRepository.ts";
import { deriveAkeruWorkspaceId } from "../EntityMemoryAccess.ts";
import { registerEntityMemoryResource } from "../EntityMemoryInvalidation.ts";
import { exportAkeruMemory } from "../MemoryExport.ts";
import { applyAkeruMemoryImport, previewAkeruMemoryImport } from "../MemoryImport.ts";

it.layer(repositoryLayer)("EntityMemoryRepository", (it) => {
  it.effect("recalls authorized project and workspace facts in a one-to-one thread", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;

      const recallAccess = {
        ...botAccess,
        projectId: ProjectId.make("shared-recall-project"),
        workspaceRoot: "/workspace/shared-recall",
      } as const;

      yield* repository.insert({
        access: recallAccess,
        revision: makeRevision("shared-project", "project", {
          partition: {
            tenantId: recallAccess.tenantId,
            scope: "project",
            partitionId: AkeruMemoryPartitionId.make(recallAccess.projectId),
          },
          entityKind: "project",
          entityId: AkeruMemoryEntityId.make(recallAccess.projectId),
          fact: "shared recall marker project",
          visibility: "shared",
        }),
      });
      const workspaceId = deriveAkeruWorkspaceId(recallAccess.projectId);
      yield* repository.insert({
        access: recallAccess,
        revision: makeRevision("shared-workspace", "workspace", {
          partition: {
            tenantId: recallAccess.tenantId,
            scope: "workspace",
            partitionId: workspaceId,
          },
          entityKind: "workspace",
          entityId: AkeruMemoryEntityId.make(workspaceId),
          fact: "shared recall marker workspace",
          sourceThreadId: null,
          visibility: "shared",
        }),
      });

      assert.deepEqual(
        (yield* repository.search({
          access: recallAccess,
          query: "shared recall marker",
          limit: 10,
        }))
          .map((revision) => revision.id)
          .sort(),
        ["shared-project", "shared-workspace"],
      );
    }),
  );

  it.effect("lists current facts and authorized revision history", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("inspect-root");
      const initial = makeRevision("inspect-1", "bot:user", { rootId });

      const next = makeRevision("inspect-2", "bot:user", {
        rootId,
        revision: 2,
        supersedesId: initial.id,
        fact: "The user prefers helix.",
      });

      yield* repository.insert({ access: botAccess, revision: initial });
      yield* repository.revise({ access: botAccess, revision: next, expectedRevision: 1 });

      const current = yield* repository.listCurrent({ access: botAccess });
      assert.isTrue(current.some((revision) => revision.id === next.id));
      const history = yield* repository.listHistory({ access: botAccess, rootId });
      assert.deepEqual(
        history.map((revision) => revision.id),
        [next.id, initial.id],
      );
    }),
  );

  it.effect("permanently deletes an authorized root and all derived FTS rows", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("delete-root");

      const initial = makeRevision("delete-memory-1", "bot:user", {
        rootId,
        fact: "delete-index-old-marker",
      });

      yield* repository.insert({ access: botAccess, revision: initial });
      yield* repository.revise({
        access: botAccess,
        expectedRevision: 1,
        revision: makeRevision("delete-memory-2", "bot:user", {
          rootId,
          revision: 2,
          supersedesId: initial.id,
          fact: "delete-index-current-marker",
        }),
      });
      yield* repository.deleteRoot({ access: botAccess, rootId });

      const missing = yield* repository.getCurrent({ access: botAccess, rootId }).pipe(Effect.exit);
      assert.isTrue(Predicate.isTagged(missing, "Failure"));

      const search = yield* repository.search({
        access: botAccess,
        query: "delete index current marker",
        limit: 10,
      });

      assert.deepEqual(search, []);
    }),
  );

  it.effect("invalidates derived copies on ordinary durable writes", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const sql = yield* SqlClient.SqlClient;
      const rootId = AkeruMemoryRootId.make("derived-write-root");
      yield* sql`INSERT INTO akeru_memory_derived_copies (tenant_id, root_id, revision_id, thread_id, created_at)
        VALUES (${botAccess.tenantId}, ${rootId}, ${AkeruMemoryId.make("stale")}, ${botAccess.threadId}, ${"2026-08-30T22:00:00.000Z"})`;
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("derived-write-root", "bot:user", { rootId }),
      });
      assert.deepEqual(
        yield* sql`SELECT root_id FROM akeru_memory_derived_copies WHERE root_id = ${rootId}`,
        [],
      );
      yield* sql`INSERT INTO akeru_memory_derived_copies (tenant_id, root_id, revision_id, thread_id, created_at)
        VALUES (${botAccess.tenantId}, ${rootId}, ${AkeruMemoryId.make("stale-2")}, ${botAccess.threadId}, ${"2026-08-30T22:00:00.000Z"})`;
      yield* repository.revise({
        access: botAccess,
        expectedRevision: 1,
        revision: makeRevision("derived-write-root-2", "bot:user", {
          rootId,
          revision: 2,
          supersedesId: AkeruMemoryId.make("derived-write-root"),
        }),
      });
      assert.deepEqual(
        yield* sql`SELECT root_id FROM akeru_memory_derived_copies WHERE root_id = ${rootId}`,
        [],
      );
    }),
  );

  it.effect("does not commit a tombstone when observational memory cannot be cleared", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("forget-clear-fails-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("clear-fails-active", "bot:user", {
          rootId,
          fact: "stale-observation-value",
        }),
      });
      const sql = yield* SqlClient.SqlClient;
      const observedThreadId = "clear-fails-thread";
      yield* sql`INSERT INTO akeru_memory_derived_copies (tenant_id, root_id, revision_id, thread_id, created_at)
        VALUES (${botAccess.tenantId}, ${rootId}, ${AkeruMemoryId.make("clear-fails-active")}, ${observedThreadId}, ${"2026-08-30T22:00:00.000Z"})`;

      const unregister = registerEntityMemoryResource(
        observedThreadId,
        observedThreadId,
        async () => {
          throw new Error("observational memory store unavailable");
        },
      );

      const exit = yield* repository
        .tombstone({
          access: botAccess,
          rootId,
          expectedRevision: 1,
          memoryId: AkeruMemoryId.make("clear-fails-tombstone"),
          updatedAt: "2026-08-30T22:00:00.000Z",
        })
        .pipe(Effect.ensuring(Effect.sync(unregister)), Effect.exit);

      assert.isTrue(Predicate.isTagged(exit, "Failure"));
      const current = yield* repository.getCurrent({ access: botAccess, rootId });
      assert.equal(current.deletionState, "active");
      assert.equal(current.revision, 1);
      assert.deepEqual(
        yield* sql`SELECT thread_id FROM akeru_memory_derived_copies WHERE root_id = ${rootId}`,
        [{ thread_id: observedThreadId }],
      );
    }),
  );

  it.effect("clears observational memory when a fact is permanently deleted", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("delete-clears-observations-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("delete-clears-active", "bot:user", { rootId }),
      });
      const sql = yield* SqlClient.SqlClient;
      const observedThreadId = "delete-clears-thread";
      yield* sql`INSERT INTO akeru_memory_derived_copies (tenant_id, root_id, revision_id, thread_id, created_at)
        VALUES (${botAccess.tenantId}, ${rootId}, ${AkeruMemoryId.make("delete-clears-active")}, ${observedThreadId}, ${"2026-08-30T22:00:00.000Z"})`;
      const cleared: Array<string> = [];

      const unregister = registerEntityMemoryResource(
        observedThreadId,
        observedThreadId,
        async (threadId) => {
          cleared.push(threadId);
        },
      );

      yield* repository
        .deleteRoot({ access: botAccess, rootId })
        .pipe(Effect.ensuring(Effect.sync(unregister)));

      assert.deepEqual(cleared, [observedThreadId]);
    }),
  );

  it.effect("roundtrips a pending fact that moved scopes with its full history", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;

      const moveAccess = {
        ...privateAccess("bot-move-archive"),
        projectId: ProjectId.make("project-move-archive"),
        legacyWorkspaceOwnerProjectId: ProjectId.make("project-move-archive"),
      } as const;

      const rootId = AkeruMemoryRootId.make("move-archive-root");
      yield* repository.insert({
        access: moveAccess,
        revision: makeRevision("move-archive-1", "bot", {
          rootId,
          partition: {
            tenantId: moveAccess.tenantId,
            scope: "bot",
            partitionId: AkeruMemoryPartitionId.make(moveAccess.botId),
          },
          entityKind: "bot",
          entityId: AkeruMemoryEntityId.make(moveAccess.botId),
          sourceThreadId: moveAccess.threadId,
          authorBotId: moveAccess.botId,
          affectedBotIds: [moveAccess.botId],
        }),
      });

      const moved = yield* repository.applyMutation({
        access: moveAccess,
        mutation: {
          operation: "fact.scope",
          memoryId: rootId,
          expectedRevision: 1,
          scope: "project",
        },
        memoryId: AkeruMemoryId.make("move-archive-2"),
        updatedAt: "2026-08-30T22:30:00.000Z",
        sharedProjectApproval: "pending",
      });

      assert.equal(moved!.approvalState, "pending");

      const exportTarget = (target: "bot" | "project") =>
        exportAkeruMemory({
          repository,
          access: moveAccess,
          target,
          complete: true,
          createdAt: "2026-08-30T23:00:00.000Z",
          conversations: [],
        });

      const botArchive = yield* exportTarget("bot");

      if (botArchive.schemaVersion !== 2) return assert.fail("Expected a V2 archive.");
      assert.deepEqual(botArchive.revisions, []);
      const archive = yield* exportTarget("project");

      if (archive.schemaVersion !== 2) return assert.fail("Expected a V2 archive.");
      assert.deepEqual(
        archive.revisions.map(({ revision }) => revision.revision),
        [1, 2],
      );

      const unchanged = yield* previewAkeruMemoryImport({
        repository,
        access: moveAccess,
        target: "project",
        archive,
      });

      assert.deepEqual(
        unchanged.items.map((item) => item.classification),
        ["skipped"],
      );

      yield* repository.deleteRoot({ access: moveAccess, rootId });

      const preview = yield* previewAkeruMemoryImport({
        repository,
        access: moveAccess,
        target: "project",
        archive,
      });

      assert.deepEqual(
        preview.items.map((item) => item.classification),
        ["new"],
      );

      const result = yield* applyAkeruMemoryImport({
        repository,
        access: moveAccess,
        target: "project",
        archive,
        previewHash: preview.previewHash,
      });

      assert.equal(result.imported, 1);
      const restored = yield* repository.getCurrent({ access: moveAccess, rootId });
      assert.equal(restored.id, moved!.id);
      assert.equal(restored.partition.scope, "project");
      assert.equal(restored.approvalState, "pending");
      const history = yield* repository.listHistory({ access: moveAccess, rootId });
      assert.deepEqual(
        history.map((revision) => [revision.partition.scope, revision.sourceThreadId]),
        [
          ["project", moveAccess.threadId],
          ["bot", moveAccess.threadId],
        ],
      );
    }),
  );

  it.effect("roundtrips workspace memory with its derived workspace identity", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const workspaceAccess = privateAccess("bot-workspace-roundtrip");
      const workspaceId = deriveAkeruWorkspaceId(workspaceAccess.projectId);
      const rootId = AkeruMemoryRootId.make("workspace-archive-roundtrip-root");

      const revision = makeRevision("workspace-archive-roundtrip-revision", workspaceId, {
        rootId,
        partition: {
          tenantId: workspaceAccess.tenantId,
          scope: "workspace",
          partitionId: workspaceId,
        },
        entityKind: "workspace",
        entityId: AkeruMemoryEntityId.make(workspaceId),
        visibility: "shared",
        sourceThreadId: null,
        authorBotId: workspaceAccess.botId,
        initiatingUserId: workspaceAccess.userId,
        affectedBotIds: [workspaceAccess.botId!],
      });

      yield* repository.insert({ access: workspaceAccess, revision });

      const archive = yield* exportAkeruMemory({
        repository,
        access: workspaceAccess,
        target: "workspace",
        complete: true,
        createdAt: "2026-08-30T23:00:00.000Z",
        conversations: [],
      });

      yield* repository.deleteRoot({ access: workspaceAccess, rootId });

      const preview = yield* previewAkeruMemoryImport({
        repository,
        access: workspaceAccess,
        target: "workspace",
        archive,
      });

      yield* applyAkeruMemoryImport({
        repository,
        access: workspaceAccess,
        target: "workspace",
        archive,
        previewHash: preview.previewHash,
      });

      const restored = yield* repository.getCurrent({ access: workspaceAccess, rootId });
      assert.equal(restored.entityKind, "workspace");
      assert.equal(restored.entityId, AkeruMemoryEntityId.make(workspaceId));
      assert.equal(restored.partition.partitionId, workspaceId);
    }),
  );

  it.effect("edits a durable fact through applyMutation", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("mutate-edit-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("mutate-edit-1", "bot:user", { rootId }),
      });

      const next = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.edit",
          memoryId: rootId,
          expectedRevision: 1,
          fact: "The user prefers helix.",
        },
        memoryId: AkeruMemoryId.make("mutate-edit-2"),
        updatedAt: "2026-08-30T22:30:00.000Z",
        sharedProjectApproval: "approved",
      });

      assert.isNotNull(next);
      assert.equal(next!.fact, "The user prefers helix.");
      assert.equal(next!.revision, 2);
      assert.equal(next!.supersedesId, "mutate-edit-1");
      const history = yield* repository.listHistory({ access: botAccess, rootId });
      assert.deepEqual(
        history.map((revision) => revision.revision),
        [2, 1],
      );

      const stale = yield* repository
        .applyMutation({
          access: botAccess,
          mutation: {
            operation: "fact.edit",
            memoryId: rootId,
            expectedRevision: 1,
            fact: "stale",
          },
          memoryId: AkeruMemoryId.make("mutate-edit-3"),
          updatedAt: "2026-08-30T22:31:00.000Z",
          sharedProjectApproval: "approved",
        })
        .pipe(Effect.exit);

      assert.isTrue(Predicate.isTagged(stale, "Failure"));

      if (Predicate.isTagged(stale, "Failure")) {
        assert.instanceOf(Cause.squash(stale.cause), EntityMemoryConflictError);
      }
    }),
  );

  it.effect("pins and unpins a durable fact", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("mutate-pin-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("mutate-pin-1", "bot:user", { rootId }),
      });

      const pinned = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.pin",
          memoryId: rootId,
          expectedRevision: 1,
          pinned: true,
        },
        memoryId: AkeruMemoryId.make("mutate-pin-2"),
        updatedAt: "2026-08-30T22:30:00.000Z",
        sharedProjectApproval: "approved",
      });

      assert.isTrue(pinned!.pinned);

      const unpinned = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.pin",
          memoryId: rootId,
          expectedRevision: 2,
          pinned: false,
        },
        memoryId: AkeruMemoryId.make("mutate-pin-3"),
        updatedAt: "2026-08-30T22:31:00.000Z",
        sharedProjectApproval: "approved",
      });

      assert.isFalse(unpinned!.pinned);
      assert.equal(unpinned!.revision, 3);
    }),
  );

  it.effect("keeps a fact's source chat when it moves between scopes", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("mutate-source-root");
      const sourceThreadId = ThreadId.make("ui-thread-1");
      const sourceMessageId = MessageId.make("ui-message-1");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("mutate-source-1", "bot:user", {
          rootId,
          sourceThreadId,
          sourceMessageId,
        }),
      });

      const shared = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.scope",
          memoryId: rootId,
          expectedRevision: 1,
          scope: "project",
        },
        memoryId: AkeruMemoryId.make("mutate-source-2"),
        updatedAt: "2026-08-30T22:30:00.000Z",
        sharedProjectApproval: "approved",
      });

      assert.equal(shared!.partition.scope, "project");
      assert.equal(shared!.sourceThreadId, sourceThreadId);
      assert.equal(shared!.sourceMessageId, sourceMessageId);

      const moved = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.scope",
          memoryId: rootId,
          expectedRevision: 2,
          scope: "bot",
        },
        memoryId: AkeruMemoryId.make("mutate-source-3"),
        updatedAt: "2026-08-30T22:31:00.000Z",
        sharedProjectApproval: "approved",
      });

      assert.equal(moved!.sourceThreadId, sourceThreadId);
      const history = yield* repository.listHistory({ access: botAccess, rootId });
      assert.deepEqual(
        history.map((revision) => revision.sourceThreadId),
        [sourceThreadId, sourceThreadId, sourceThreadId],
      );
    }),
  );

  it.effect("rejects then approves a pending durable fact", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("mutate-decide-root");

      const foreignAccess = {
        ...botAccess,
        threadId: ThreadId.make("thread-decide-seed"),
      };

      const encodeJson = <Value>(value: Value) =>
        // The seeded row only carries empty objects and short bot-id arrays;
        // keep the JSON encoding inline and side-effect free.
        JSON.stringify(value) as string;

      const pending = makeRevision("mutate-decide-1", "project", {
        rootId,
        partition: {
          tenantId: botAccess.tenantId,
          scope: "project",
          partitionId: AkeruMemoryPartitionId.make(botAccess.projectId),
        },
        entityKind: "project",
        entityId: AkeruMemoryEntityId.make(botAccess.projectId),
        visibility: "shared",
        approvalState: "pending",
      });

      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO akeru_memory_revisions (
        memory_id, root_id, revision, tenant_id, scope, partition_id,
        entity_kind, entity_id, kind, value_json, fact_text,
        source_thread_id, source_message_id, author_bot_id, initiating_user_id,
        created_at, confirmed_at, updated_at, confidence, approval_state,
        supersedes_id, superseded_by_id, visibility, deletion_state,
        pinned, sensitive, affected_bot_ids_json
      ) VALUES (
        ${pending.id}, ${pending.rootId}, ${pending.revision}, ${pending.partition.tenantId},
        ${pending.partition.scope}, ${pending.partition.partitionId}, ${pending.entityKind},
        ${pending.entityId}, ${pending.kind}, ${encodeJson(pending.value)}, ${pending.fact},
        ${pending.sourceThreadId}, ${pending.sourceMessageId}, ${pending.authorBotId},
        ${pending.initiatingUserId}, ${pending.createdAt}, ${pending.confirmedAt},
        ${pending.updatedAt}, ${pending.confidence}, ${pending.approvalState},
        ${pending.supersedesId}, ${pending.supersededById}, ${pending.visibility},
        ${pending.deletionState}, ${pending.pinned ? 1 : 0}, ${pending.sensitive ? 1 : 0},
        ${encodeJson(pending.affectedBotIds)}
      )`;
      assert.isDefined(foreignAccess);

      const rejected = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.decide",
          memoryId: rootId,
          expectedRevision: 1,
          decision: "reject",
        },
        memoryId: AkeruMemoryId.make("mutate-decide-2"),
        updatedAt: "2026-08-30T22:30:00.000Z",
        sharedProjectApproval: "approved",
      });

      assert.equal(rejected!.approvalState, "rejected");

      const approved = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.decide",
          memoryId: rootId,
          expectedRevision: 2,
          decision: "approve",
        },
        memoryId: AkeruMemoryId.make("mutate-decide-3"),
        updatedAt: "2026-08-30T22:31:00.000Z",
        sharedProjectApproval: "approved",
      });

      assert.equal(approved!.approvalState, "approved");
      assert.isTrue(
        (yield* repository.listCurrent({ access: botAccess })).some(
          (revision) => revision.rootId === rootId,
        ),
      );
    }),
  );

  it.effect("approves a pending project fact when it moves back to private memory", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("mutate-pending-private-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("mutate-pending-private-1", "bot:user", { rootId }),
      });

      const shared = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.scope",
          memoryId: rootId,
          expectedRevision: 1,
          scope: "project",
        },
        memoryId: AkeruMemoryId.make("mutate-pending-private-2"),
        updatedAt: "2026-08-30T22:30:00.000Z",
        sharedProjectApproval: "pending",
      });

      assert.equal(shared!.approvalState, "pending");

      const back = yield* repository.applyMutation({
        access: botAccess,
        mutation: { operation: "fact.scope", memoryId: rootId, expectedRevision: 2, scope: "bot" },
        memoryId: AkeruMemoryId.make("mutate-pending-private-3"),
        updatedAt: "2026-08-30T22:31:00.000Z",
        sharedProjectApproval: "pending",
      });

      assert.equal(back!.visibility, "private");
      assert.equal(back!.approvalState, "approved");
    }),
  );

  it.effect("accepts only permanent deletion after a fact is forgotten", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("mutate-forgotten-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("mutate-forgotten-1", "bot:user", { rootId }),
      });
      yield* repository.applyMutation({
        access: botAccess,
        mutation: { operation: "fact.forget", memoryId: rootId, expectedRevision: 1 },
        memoryId: AkeruMemoryId.make("mutate-forgotten-2"),
        updatedAt: "2026-08-30T22:30:00.000Z",
        sharedProjectApproval: "approved",
      });

      const edited = yield* repository
        .applyMutation({
          access: botAccess,
          mutation: {
            operation: "fact.edit",
            memoryId: rootId,
            expectedRevision: 2,
            fact: "revived",
          },
          memoryId: AkeruMemoryId.make("mutate-forgotten-3"),
          updatedAt: "2026-08-30T22:31:00.000Z",
          sharedProjectApproval: "approved",
        })
        .pipe(Effect.exit);

      assert.isTrue(Predicate.isTagged(edited, "Failure"));
    }),
  );

  it.effect("forgets then permanently deletes a durable fact", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const sql = yield* SqlClient.SqlClient;
      const rootId = AkeruMemoryRootId.make("mutate-delete-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("mutate-delete-1", "bot:user", {
          rootId,
          fact: "mutate-delete-marker",
        }),
      });
      yield* sql`INSERT INTO akeru_memory_derived_copies (tenant_id, root_id, revision_id, thread_id, created_at)
        VALUES (${botAccess.tenantId}, ${rootId}, ${AkeruMemoryId.make("mutate-delete-1")}, ${botAccess.threadId}, ${"2026-08-30T22:00:00.000Z"})`;

      const forgotten = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.forget",
          memoryId: rootId,
          expectedRevision: 1,
        },
        memoryId: AkeruMemoryId.make("mutate-delete-2"),
        updatedAt: "2026-08-30T22:30:00.000Z",
        sharedProjectApproval: "approved",
      });

      assert.equal(forgotten!.deletionState, "tombstoned");
      assert.deepEqual(
        yield* sql`SELECT root_id FROM akeru_memory_derived_copies WHERE root_id = ${rootId}`,
        [],
      );
      assert.deepEqual(
        yield* repository.search({ access: botAccess, query: "mutate delete marker", limit: 10 }),
        [],
      );

      const deleted = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.delete",
          memoryId: rootId,
          expectedRevision: 2,
        },
        memoryId: AkeruMemoryId.make("mutate-delete-3"),
        updatedAt: "2026-08-30T22:31:00.000Z",
        sharedProjectApproval: "approved",
      });

      assert.isNull(deleted);
      const missing = yield* repository.getCurrent({ access: botAccess, rootId }).pipe(Effect.exit);
      assert.isTrue(Predicate.isTagged(missing, "Failure"));
    }),
  );

  it.effect("does not let another thread's owner mutate a fact", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("mutate-owner-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("mutate-owner-1", "bot:user", { rootId }),
      });

      const wrongBot = yield* repository
        .applyMutation({
          access: privateAccess("other-bot"),
          mutation: {
            operation: "fact.pin",
            memoryId: rootId,
            expectedRevision: 1,
            pinned: true,
          },
          memoryId: AkeruMemoryId.make("mutate-owner-2"),
          updatedAt: "2026-08-30T22:30:00.000Z",
          sharedProjectApproval: "approved",
        })
        .pipe(Effect.exit);

      assert.isTrue(Predicate.isTagged(wrongBot, "Failure"));
      assert.equal((yield* repository.getCurrent({ access: botAccess, rootId })).revision, 1);
    }),
  );

  it.effect("inserts an approved fact into a shared group scope for every member", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;

      const revision = yield* repository.insertScopedFact({
        access: sharedAccess,
        scope: "group",
        fact: "The group ships on Fridays.",
        sensitive: false,
        confidence: 1,
        sourceMessageId: null,
        memoryId: AkeruMemoryId.make("scoped-group-fact"),
        createdAt: "2026-09-23T08:00:00.000Z",
      });

      assert.equal(revision.partition.scope, "group");
      assert.equal(revision.approvalState, "approved");
      assert.equal(revision.authorBotId, BotId.make("bot"));
      assert.deepEqual(revision.affectedBotIds, [BotId.make("bot")]);
      assert.isNull(revision.sourceThreadId);

      const outsideGroup = yield* repository
        .insertScopedFact({
          access: botAccess,
          scope: "group",
          fact: "No group here.",
          sensitive: false,
          confidence: 1,
          sourceMessageId: null,
          memoryId: AkeruMemoryId.make("scoped-no-group"),
          createdAt: "2026-09-23T08:00:00.000Z",
        })
        .pipe(Effect.exit);

      assert.isTrue(Predicate.isTagged(outsideGroup, "Failure"));
    }),
  );
});
