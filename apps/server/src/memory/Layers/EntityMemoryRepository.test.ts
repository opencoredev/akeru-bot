// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryPartitionId,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  GroupId,
  MessageId,
  ProjectId,
  ThreadId,
  type AkeruMemoryRevision,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  EntityMemoryConflictError,
  EntityMemoryRepository,
  type EntityMemoryRepositoryShape,
} from "../Services/EntityMemoryRepository.ts";
import { MemoryRevisionWriteLockLive } from "../Services/MemoryRevisionWriteLock.ts";
import { EntityMemoryRepositoryLive } from "./EntityMemoryRepository.ts";
import { deriveAkeruWorkspaceId, resolveMemoryArchivePartitions } from "../EntityMemoryAccess.ts";
import { exportAkeruMemory } from "../MemoryExport.ts";
import { applyAkeruMemoryImport, previewAkeruMemoryImport } from "../MemoryImport.ts";

const repositoryLayer = Layer.mergeAll(
  EntityMemoryRepositoryLive.pipe(
    Layer.provide(MemoryRevisionWriteLockLive),
    Layer.provide(SqlitePersistenceMemory),
  ),
  SqlitePersistenceMemory,
);

const makeRevision = (
  id: string,
  partitionId: string,
  overrides: Partial<AkeruMemoryRevision> = {},
): AkeruMemoryRevision => {
  const authorBotId = BotId.make(partitionId.includes(":") ? partitionId.split(":")[0]! : "bot");
  return {
    id: AkeruMemoryId.make(id),
    rootId: AkeruMemoryRootId.make(id),
    revision: 1,
    partition: {
      tenantId: AkeruMemoryTenantId.make("tenant"),
      scope: "bot-user",
      partitionId: AkeruMemoryPartitionId.make(partitionId),
    },
    entityKind: "user",
    entityId: AkeruMemoryEntityId.make("user"),
    kind: "preference",
    value: { editor: "vim" },
    fact: `The user in ${partitionId} prefers vim.`,
    sourceThreadId: ThreadId.make(`thread-${authorBotId}`),
    sourceMessageId: MessageId.make("message"),
    authorBotId,
    initiatingUserId: AkeruMemoryUserId.make("user"),
    createdAt: "2026-08-30T21:00:00.000Z",
    confirmedAt: "2026-08-30T21:00:00.000Z",
    updatedAt: "2026-08-30T21:00:00.000Z",
    confidence: 0.9,
    approvalState: "approved",
    supersedesId: null,
    supersededById: null,
    visibility: "private",
    deletionState: "active",
    pinned: false,
    sensitive: false,
    affectedBotIds: [authorBotId],
    ...overrides,
  };
};

it("preserves revision history and FTS recall after repository restart", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-memory-restart-"));
    const dbPath = NodePath.join(directory, "state.sqlite");
    const restartedLayer = EntityMemoryRepositoryLive.pipe(
      Layer.provide(MemoryRevisionWriteLockLive),
      Layer.provideMerge(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    );
    const rootId = AkeruMemoryRootId.make("restart-memory-root");
    const first = makeRevision("restart-memory-1", "bot:user", {
      rootId,
      fact: "restart marker old value",
    });
    const second = makeRevision("restart-memory-2", "bot:user", {
      rootId,
      revision: 2,
      supersedesId: first.id,
      fact: "restart marker current value",
    });
    yield* Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      yield* repository.insert({ access: botAccess, revision: first });
      yield* repository.revise({ access: botAccess, revision: second, expectedRevision: 1 });
    }).pipe(Effect.provide(restartedLayer));
    yield* Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const history = yield* repository.listHistory({ access: botAccess, rootId });
      assert.deepEqual(
        history.map((revision) => revision.id),
        [second.id, first.id],
      );
      const recalled = yield* repository.search({
        access: botAccess,
        query: "restart marker current",
        limit: 10,
      });
      assert.deepEqual(
        recalled.map((revision) => revision.id),
        [second.id],
      );
    }).pipe(Effect.provide(restartedLayer));
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }));

const privateAccess = (botId: string) =>
  ({
    tenantId: AkeruMemoryTenantId.make("tenant"),
    userId: AkeruMemoryUserId.make("user"),
    threadId: ThreadId.make(`thread-${botId}`),
    projectId: ProjectId.make("project"),
    workspaceRoot: "/workspace",
    legacyWorkspaceOwnerProjectId: ProjectId.make("project"),
    botId: BotId.make(botId),
    groupId: null,
    respondingBotId: null,
    groupMemberBotIds: [],
  }) as const;

const insert = (repository: EntityMemoryRepositoryShape, revision: AkeruMemoryRevision) =>
  repository.insert({
    access: privateAccess(revision.partition.partitionId.split(":")[0] ?? "bot"),
    revision,
  });

const botAccess = privateAccess("bot");

const sharedAccess = {
  ...privateAccess("bot"),
  groupId: GroupId.make("group"),
  respondingBotId: BotId.make("bot"),
  groupMemberBotIds: [BotId.make("bot")],
} as const;

it.layer(repositoryLayer)("EntityMemoryRepository", (it) => {
  it.effect("queries only explicit authorized partitions", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      yield* insert(repository, makeRevision("first", "bot-1:user"));
      yield* insert(repository, makeRevision("second", "bot-2:user"));

      const rows = yield* repository.search({
        access: privateAccess("bot-1"),
        query: "prefers vim",
        limit: 10,
      });
      assert.deepEqual(
        rows.map((row) => row.id),
        ["first"],
      );
    }),
  );

  it.effect("rejects unapproved, forged, and mismatched direct inserts", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const invalid = [
        makeRevision("pending-insert", "bot:user", { approvalState: "pending" }),
        makeRevision("forged-user-insert", "bot:user", {
          initiatingUserId: AkeruMemoryUserId.make("other-user"),
        }),
        makeRevision("forged-bot-insert", "bot:user", {
          authorBotId: BotId.make("other-bot"),
        }),
        makeRevision("mismatched-entity-insert", "bot:user", {
          entityKind: "project",
          entityId: AkeruMemoryEntityId.make("project"),
        }),
      ];

      const exits = yield* Effect.forEach(invalid, (revision) =>
        repository.insert({ access: botAccess, revision }).pipe(Effect.exit),
      );
      assert.isTrue(exits.every((exit) => exit._tag === "Failure"));
    }),
  );

  it.effect("rejects unapproved, forged, and mismatched direct revisions", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("validated-revise-root");
      const first = makeRevision("validated-revise-1", "bot:user", { rootId });
      yield* repository.insert({ access: botAccess, revision: first });
      const baseRevision = makeRevision("validated-revise-2", "bot:user", {
        rootId,
        revision: 2,
        supersedesId: first.id,
      });
      const invalid = [
        { ...baseRevision, approvalState: "rejected" as const },
        { ...baseRevision, initiatingUserId: AkeruMemoryUserId.make("other-user") },
        { ...baseRevision, authorBotId: BotId.make("other-bot") },
        {
          ...baseRevision,
          entityKind: "project" as const,
          entityId: AkeruMemoryEntityId.make("project"),
        },
      ];

      const exits = yield* Effect.forEach(invalid, (revision) =>
        repository.revise({ access: botAccess, expectedRevision: 1, revision }).pipe(Effect.exit),
      );
      assert.isTrue(exits.every((exit) => exit._tag === "Failure"));
      assert.equal((yield* repository.getCurrent({ access: botAccess, rootId })).id, first.id);
    }),
  );

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

  it.effect("preserves revisions and rejects stale writes", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("root");
      const initial = makeRevision("memory-1", "bot:user", { rootId });
      yield* repository.insert({ access: botAccess, revision: initial });
      const next = makeRevision("memory-2", "bot:user", {
        rootId,
        revision: 2,
        supersedesId: initial.id,
        fact: "The user prefers helix.",
      });
      yield* repository.revise({ access: botAccess, revision: next, expectedRevision: 1 });
      const current = yield* repository.getCurrent({ access: botAccess, rootId });
      assert.equal(current.id, "memory-2");
      assert.equal(current.revision, 2);

      const stale = yield* repository
        .revise({
          access: botAccess,
          revision: makeRevision("memory-3", "bot:user", {
            rootId,
            revision: 2,
            supersedesId: initial.id,
          }),
          expectedRevision: 1,
        })
        .pipe(Effect.exit);
      assert.isTrue(stale._tag === "Failure");
      if (stale._tag === "Failure") {
        assert.instanceOf(Cause.squash(stale.cause), EntityMemoryConflictError);
      }
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
      assert.isTrue(missing._tag === "Failure");
      const search = yield* repository.search({
        access: botAccess,
        query: "delete index current marker",
        limit: 10,
      });
      assert.deepEqual(search, []);
    }),
  );

  it.effect("does not let shared access delete an older private revision", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("delete-private-history-root");
      const initial = makeRevision("delete-private-history-1", "bot-1:user", { rootId });
      yield* repository.insert({ access: privateAccess("bot-1"), revision: initial });
      yield* repository.revise({
        access: privateAccess("bot-1"),
        expectedRevision: 1,
        revision: makeRevision("delete-private-history-2", "project", {
          rootId,
          revision: 2,
          supersedesId: initial.id,
          partition: {
            tenantId: AkeruMemoryTenantId.make("tenant"),
            scope: "project",
            partitionId: AkeruMemoryPartitionId.make("project"),
          },
          entityKind: "project",
          entityId: AkeruMemoryEntityId.make("project"),
          visibility: "shared",
          authorBotId: BotId.make("bot-1"),
          affectedBotIds: [BotId.make("bot-1")],
        }),
      });

      const exit = yield* repository
        .deleteRoot({
          access: privateAccess("bot-2"),
          rootId,
        })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
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

  it.effect("does not return all memory for punctuation-only search", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      yield* insert(repository, makeRevision("punctuation-memory", "bot:user"));
      assert.deepEqual(
        yield* repository.search({
          access: botAccess,
          query: "🤖?!",
          limit: 10,
        }),
        [],
      );
    }),
  );

  it.effect("removes a tombstone from recall before cleanup", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("forget-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("active", "bot:user", {
          rootId,
          fact: "secret-disappear-value",
        }),
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO akeru_memory_derived_copies (tenant_id, root_id, revision_id, thread_id, created_at)
        VALUES (${botAccess.tenantId}, ${rootId}, ${AkeruMemoryId.make("active")}, ${botAccess.threadId}, ${"2026-08-30T22:00:00.000Z"})`;
      yield* repository.tombstone({
        access: botAccess,
        rootId,
        expectedRevision: 1,
        memoryId: AkeruMemoryId.make("tombstone"),
        updatedAt: "2026-08-30T22:00:00.000Z",
      });
      const rows = yield* repository.search({
        access: botAccess,
        query: "secret-disappear-value",
        limit: 10,
      });
      assert.equal(rows.length, 0);
      const ftsRows = yield* sql<{
        readonly memory_id: string;
      }>`SELECT memory_id FROM akeru_memory_fts WHERE memory_id = ${"active"}`;
      assert.deepEqual(ftsRows, []);
      const derivedRows = yield* sql<{
        readonly root_id: string;
      }>`SELECT root_id FROM akeru_memory_derived_copies WHERE root_id = ${rootId}`;
      assert.deepEqual(derivedRows, []);
      const current = yield* repository.getCurrent({ access: botAccess, rootId });
      assert.equal(current.deletionState, "tombstoned");
      assert.equal(current.revision, 2);
      assert.isFalse(
        (yield* repository.listCurrent({ access: botAccess })).some(
          (revision) => revision.rootId === rootId,
        ),
      );

      const resurrection = yield* repository
        .revise({
          access: botAccess,
          expectedRevision: 2,
          revision: makeRevision("resurrected", "bot:user", {
            rootId,
            revision: 3,
            supersedesId: current.id,
            fact: "This must stay forgotten.",
          }),
        })
        .pipe(Effect.exit);
      assert.isTrue(resurrection._tag === "Failure");
      if (resurrection._tag === "Failure") {
        assert.instanceOf(Cause.squash(resurrection.cause), EntityMemoryConflictError);
      }
    }),
  );

  it.effect("rejects a second current head for the same tenant and root", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("single-head-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("head-1", "bot:user", { rootId }),
      });
      const exit = yield* repository
        .insert({
          access: botAccess,
          revision: makeRevision("head-2", "bot:user", { rootId }),
        })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        assert.instanceOf(Cause.squash(exit.cause), EntityMemoryConflictError);
      }
    }),
  );

  it.effect("does not read another bot's memory by root id", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("private-root");
      yield* repository.insert({
        access: privateAccess("bot-1"),
        revision: makeRevision("private-memory", "bot-1:user", { rootId }),
      });
      const exit = yield* repository
        .getCurrent({
          access: privateAccess("bot-2"),
          rootId,
        })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("does not let a revision move to another partition", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("fixed-partition-root");
      const initial = makeRevision("fixed-1", "bot:user", { rootId });
      yield* repository.insert({ access: botAccess, revision: initial });
      const exit = yield* repository
        .revise({
          access: botAccess,
          expectedRevision: 1,
          revision: makeRevision("fixed-2", "bot:other-user", {
            rootId,
            revision: 2,
            supersedesId: initial.id,
          }),
        })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("rejects private partitions for shared threads", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const exit = yield* repository
        .insert({
          access: sharedAccess,
          revision: makeRevision("shared-private", "bot:user"),
        })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("previews and atomically imports a new authorized history", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const sql = yield* SqlClient.SqlClient;
      const partitions = yield* resolveMemoryArchivePartitions(botAccess, "bot");
      const rootId = AkeruMemoryRootId.make("import-root");
      const first = makeRevision("import-1", "bot:user", {
        rootId,
        supersededById: AkeruMemoryId.make("import-2"),
        fact: "import-search-marker first",
      });
      const second = makeRevision("import-2", "bot:user", {
        rootId,
        revision: 2,
        supersedesId: first.id,
        fact: "import-search-marker current",
      });
      assert.isDefined(repository.previewImport);
      assert.isDefined(repository.applyImport);
      const preview = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [first, second],
      });
      assert.equal(preview.items[0]?.classification, "new");
      const applied = yield* repository.applyImport!({
        access: botAccess,
        partitions,
        revisions: [first, second],
        previewHash: preview.previewHash,
      });
      assert.deepEqual(applied, { imported: 1, changed: 0, skipped: 0 });
      const history = yield* repository.listHistory({ access: botAccess, rootId });
      assert.deepEqual(
        history.map((revision) => revision.id),
        [second.id, first.id],
      );
      const recalled = yield* repository.search({
        access: botAccess,
        query: "import search marker",
        limit: 10,
      });
      assert.deepEqual(
        recalled.map((revision) => revision.id),
        [second.id],
      );
    }),
  );

  it.effect("rejects a stale import preview without changing local rows", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const partitions = yield* resolveMemoryArchivePartitions(botAccess, "bot");
      const rootId = AkeruMemoryRootId.make("stale-import-root");
      const archived = makeRevision("stale-import-archive", "bot:user", { rootId });
      const preview = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [archived],
      });
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("stale-import-local", "bot:user", { rootId }),
      });
      const exit = yield* repository.applyImport!({
        access: botAccess,
        partitions,
        revisions: [archived],
        previewHash: preview.previewHash,
      }).pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
      const history = yield* repository.listHistory({ access: botAccess, rootId });
      assert.deepEqual(
        history.map((revision) => revision.id),
        ["stale-import-local"],
      );
    }),
  );

  it.effect("does not let an invalid archive chain replace local history", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const partitions = yield* resolveMemoryArchivePartitions(botAccess, "bot");
      const rootId = AkeruMemoryRootId.make("invalid-chain-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("invalid-chain-local", "bot:user", { rootId }),
      });
      // Revision 2 with no revision 1 is not a valid chain.
      const broken = makeRevision("invalid-chain-archive", "bot:user", { rootId, revision: 2 });
      const preview = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [broken],
      });
      assert.equal(preview.items[0]?.classification, "conflicting");
      const exit = yield* repository.applyImport!({
        access: botAccess,
        partitions,
        revisions: [broken],
        previewHash: preview.previewHash,
        resolutions: [{ rootId, decision: "use-archive" }],
      }).pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
      const history = yield* repository.listHistory({ access: botAccess, rootId });
      assert.deepEqual(
        history.map((revision) => revision.id),
        ["invalid-chain-local"],
      );
    }),
  );

  it.effect("rejects an archive record whose owner kind does not match its target", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const partitions = yield* resolveMemoryArchivePartitions(botAccess, "bot");
      const forged = {
        ...makeRevision("forged-kind-1", "bot:user", {
          rootId: AkeruMemoryRootId.make("forged-kind-root"),
        }),
        // The bot entity id with a forged kind must not pass the owner check.
        entityKind: "project" as const,
        entityId: AkeruMemoryEntityId.make("bot"),
      };
      const exit = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [forged],
      }).pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
    }),
  );

  it.effect("derives import ownership instead of trusting archive partition fields", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const partitions = yield* resolveMemoryArchivePartitions(botAccess, "bot");
      const forged = makeRevision("forged-import", "project:other", {
        partition: {
          tenantId: AkeruMemoryTenantId.make("foreign-tenant"),
          scope: "bot",
          partitionId: AkeruMemoryPartitionId.make("foreign-bot"),
        },
        visibility: "shared",
        entityKind: "project",
        entityId: AkeruMemoryEntityId.make("foreign-project"),
        sourceThreadId: ThreadId.make("foreign-thread"),
        authorBotId: BotId.make("foreign-bot"),
        initiatingUserId: AkeruMemoryUserId.make("foreign-user"),
        affectedBotIds: [BotId.make("foreign-bot")],
      });
      const exit = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [forged],
      }).pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("rejects mixed import authority domains at the repository boundary", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const authorized = yield* resolveMemoryArchivePartitions(botAccess, "all");
      const partitions = authorized.filter(
        (candidate) => candidate.scope === "user" || candidate.scope === "project",
      );
      const exit = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [makeRevision("mixed-authority-import", "bot:user")],
      }).pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        assert.match(
          Cause.pretty(exit.cause),
          /one thread, bot, project, or workspace authority domain/,
        );
      }
    }),
  );

  it.effect("maps bot imports by entity domain instead of archived partition scope", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const partitions = yield* resolveMemoryArchivePartitions(botAccess, "bot");
      const botRevision = makeRevision("bot-domain-import", "foreign-bot-user", {
        partition: {
          tenantId: botAccess.tenantId,
          scope: "bot-user",
          partitionId: AkeruMemoryPartitionId.make("foreign-bot-user"),
        },
        entityKind: "bot",
        entityId: AkeruMemoryEntityId.make("foreign-bot"),
      });
      const exit = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [botRevision],
      }).pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("classifies identical, extending, divergent, and re-homed histories", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const sql = yield* SqlClient.SqlClient;
      const partitions = yield* resolveMemoryArchivePartitions(botAccess, "bot");
      const rootId = AkeruMemoryRootId.make("classified-import-root");
      const first = makeRevision("classified-import-1", "bot", {
        rootId,
        partition: {
          tenantId: botAccess.tenantId,
          scope: "bot",
          partitionId: AkeruMemoryPartitionId.make(botAccess.botId!),
        },
        entityKind: "bot",
        entityId: AkeruMemoryEntityId.make(botAccess.botId!),
        sourceThreadId: null,
        sourceMessageId: null,
        authorBotId: botAccess.botId,
        initiatingUserId: botAccess.userId,
        affectedBotIds: [botAccess.botId!],
      });
      yield* repository.insert({ access: botAccess, revision: first });

      const skipped = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [first],
      });
      assert.equal(skipped.items[0]?.classification, "skipped");

      const second = makeRevision("classified-import-2", "bot", {
        ...first,
        id: AkeruMemoryId.make("classified-import-2"),
        revision: 2,
        supersedesId: first.id,
        supersededById: null,
        fact: "The bot now uses Helix.",
        updatedAt: "2026-08-30T22:00:00.000Z",
      });
      const extendingFirst = { ...first, supersededById: second.id };
      const changed = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [extendingFirst, second],
      });
      assert.equal(changed.items[0]?.classification, "changed");
      yield* sql`INSERT INTO akeru_memory_derived_copies (tenant_id, root_id, revision_id, thread_id, created_at)
        VALUES (${botAccess.tenantId}, ${rootId}, ${first.id}, ${botAccess.threadId}, ${first.updatedAt})`;
      yield* repository.applyImport!({
        access: botAccess,
        partitions,
        revisions: [extendingFirst, second],
        previewHash: changed.previewHash,
      });
      assert.deepEqual(
        yield* sql`SELECT root_id FROM akeru_memory_derived_copies WHERE root_id = ${rootId}`,
        [],
      );

      const divergent = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [{ ...first, fact: "A divergent history." }],
      });
      assert.equal(divergent.items[0]?.classification, "conflicting");
      const unresolved = yield* repository
        .applyImport({
          access: botAccess,
          partitions,
          revisions: [{ ...first, fact: "A divergent history." }],
          previewHash: divergent.previewHash,
        })
        .pipe(Effect.exit);
      assert.isTrue(unresolved._tag === "Failure");
      yield* repository.applyImport!({
        access: botAccess,
        partitions,
        revisions: [{ ...first, fact: "A divergent history." }],
        previewHash: divergent.previewHash,
        resolutions: [{ rootId: first.rootId, decision: "use-archive" }],
      });
      const replaced = yield* repository.getCurrent({ access: botAccess, rootId: first.rootId });
      assert.equal(replaced.fact, "A divergent history.");

      const sharedRootId = AkeruMemoryRootId.make("rehome-import-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("rehome-local", "project", {
          rootId: sharedRootId,
          partition: {
            tenantId: botAccess.tenantId,
            scope: "project",
            partitionId: AkeruMemoryPartitionId.make(botAccess.projectId),
          },
          entityKind: "project",
          entityId: AkeruMemoryEntityId.make(botAccess.projectId),
          visibility: "shared",
        }),
      });
      const rehome = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [makeRevision("rehome-archive", "bot", { rootId: sharedRootId })],
      }).pipe(Effect.exit);
      assert.isTrue(rehome._tag === "Failure");
    }),
  );

  it.effect("roundtrips durable history without applying archived conversation OM", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const roundtripAccess = privateAccess("bot-archive-roundtrip");
      const rootId = AkeruMemoryRootId.make("archive-roundtrip-root");
      const durable = makeRevision("archive-roundtrip-revision", "bot", {
        rootId,
        partition: {
          tenantId: roundtripAccess.tenantId,
          scope: "bot",
          partitionId: AkeruMemoryPartitionId.make(roundtripAccess.botId!),
        },
        entityKind: "bot",
        entityId: AkeruMemoryEntityId.make(roundtripAccess.botId!),
        sourceThreadId: roundtripAccess.threadId,
        authorBotId: roundtripAccess.botId,
        initiatingUserId: roundtripAccess.userId,
        affectedBotIds: [roundtripAccess.botId!],
      });
      yield* repository.insert({ access: roundtripAccess, revision: durable });
      const archive = yield* exportAkeruMemory({
        repository,
        access: roundtripAccess,
        target: "bot",
        complete: true,
        createdAt: "2026-08-30T23:00:00.000Z",
        conversations: [
          {
            threadId: roundtripAccess.threadId,
            snapshot: {
              current: {
                id: "archived-om",
                generationCount: 1,
                originType: "initial",
                activeObservations: "Archived conversation context must remain derived.",
                bufferedObservations: "",
                bufferedReflection: null,
                totalTokensObserved: 9,
                observationTokenCount: 9,
                createdAt: "2026-08-30T22:00:00.000Z",
                updatedAt: "2026-08-30T22:00:00.000Z",
              },
              history: [],
            },
          },
        ],
      });
      yield* repository.deleteRoot({ access: roundtripAccess, rootId });

      const preview = yield* previewAkeruMemoryImport({
        repository,
        access: roundtripAccess,
        target: "bot",
        archive,
      });
      const result = yield* applyAkeruMemoryImport({
        repository,
        access: roundtripAccess,
        target: "bot",
        archive,
        previewHash: preview.previewHash,
      });

      assert.equal(result.imported, 1);
      if (archive.schemaVersion !== 2) return assert.fail("Expected a V2 archive.");
      assert.equal(archive.conversations[0]?.snapshot.current?.id, "archived-om");
      const restored = yield* repository.getCurrent({ access: roundtripAccess, rootId });
      assert.equal(restored.id, durable.id);
      assert.equal(restored.fact, durable.fact);
      assert.deepEqual(
        yield* repository.search({
          access: roundtripAccess,
          query: "Archived conversation context remain derived",
          limit: 10,
        }),
        [],
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

  it.effect("edits and pins memory in the legacy workspace partition", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const workspaceAccess = privateAccess("bot-legacy-workspace");
      const workspaceId = deriveAkeruWorkspaceId(workspaceAccess.projectId);
      const legacyWorkspaceId = (yield* resolveMemoryArchivePartitions(
        workspaceAccess,
        "workspace",
      )).find((partition) => partition.partitionId !== workspaceId)?.partitionId;
      if (!legacyWorkspaceId) return assert.fail("Expected a legacy workspace partition.");
      const rootId = AkeruMemoryRootId.make("legacy-workspace-root");
      const initial = makeRevision("legacy-workspace-1", legacyWorkspaceId, {
        rootId,
        partition: {
          tenantId: workspaceAccess.tenantId,
          scope: "workspace",
          partitionId: legacyWorkspaceId,
        },
        entityKind: "workspace",
        entityId: AkeruMemoryEntityId.make(legacyWorkspaceId),
        visibility: "shared",
        sourceThreadId: null,
        authorBotId: workspaceAccess.botId,
        initiatingUserId: workspaceAccess.userId,
        affectedBotIds: [workspaceAccess.botId!],
      });
      const edited = {
        ...initial,
        id: AkeruMemoryId.make("legacy-workspace-2"),
        revision: 2,
        supersedesId: initial.id,
        fact: "The legacy workspace fact was edited.",
      };
      const pinned = {
        ...edited,
        id: AkeruMemoryId.make("legacy-workspace-3"),
        revision: 3,
        supersedesId: edited.id,
        pinned: true,
      };

      yield* repository.insert({ access: workspaceAccess, revision: initial });
      yield* repository.revise({ access: workspaceAccess, revision: edited, expectedRevision: 1 });
      yield* repository.revise({ access: workspaceAccess, revision: pinned, expectedRevision: 2 });

      const current = yield* repository.getCurrent({ access: workspaceAccess, rootId });
      assert.equal(current.fact, edited.fact);
      assert.isTrue(current.pinned);
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
      assert.isTrue(stale._tag === "Failure");
      if (stale._tag === "Failure") {
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

  it.effect("changes scope only to an owner-valid target", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("mutate-scope-root");
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("mutate-scope-1", "bot:user", { rootId }),
      });
      const moved = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.scope",
          memoryId: rootId,
          expectedRevision: 1,
          scope: "project",
        },
        memoryId: AkeruMemoryId.make("mutate-scope-2"),
        updatedAt: "2026-08-30T22:30:00.000Z",
        sharedProjectApproval: "approved",
      });
      assert.equal(moved!.partition.scope, "project");
      assert.equal(moved!.entityKind, "project");
      assert.equal(moved!.visibility, "shared");
      const back = yield* repository.applyMutation({
        access: botAccess,
        mutation: {
          operation: "fact.scope",
          memoryId: rootId,
          expectedRevision: 2,
          scope: "bot",
        },
        memoryId: AkeruMemoryId.make("mutate-scope-3"),
        updatedAt: "2026-08-30T22:31:00.000Z",
        sharedProjectApproval: "approved",
      });
      assert.equal(back!.partition.scope, "bot");
      assert.equal(back!.visibility, "private");
      // A group scope is not owned by a one-to-one thread and must fail.
      const denied = yield* repository
        .applyMutation({
          access: botAccess,
          mutation: {
            operation: "fact.scope",
            memoryId: rootId,
            expectedRevision: 3,
            scope: "group",
          },
          memoryId: AkeruMemoryId.make("mutate-scope-4"),
          updatedAt: "2026-08-30T22:32:00.000Z",
          sharedProjectApproval: "approved",
        })
        .pipe(Effect.exit);
      assert.isTrue(denied._tag === "Failure");
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
      const encodeJson = (value: unknown) =>
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
      assert.isTrue(edited._tag === "Failure");
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
      assert.isTrue(missing._tag === "Failure");
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
      assert.isTrue(wrongBot._tag === "Failure");
      assert.equal((yield* repository.getCurrent({ access: botAccess, rootId })).revision, 1);
    }),
  );
});
