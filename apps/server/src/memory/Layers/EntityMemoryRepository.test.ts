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
): AkeruMemoryRevision => ({
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
  sourceThreadId: ThreadId.make("thread"),
  sourceMessageId: MessageId.make("message"),
  authorBotId: BotId.make("bot"),
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
  affectedBotIds: [BotId.make("bot")],
  ...overrides,
});

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

  it.effect("keeps derived-copy invalidations durable until every thread is cleared", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const rootId = AkeruMemoryRootId.make("derived-copy-root");
      const recordDerivedCopies = repository.recordDerivedCopies;
      const listDerivedCopies = repository.listDerivedCopies;
      const listPendingDerivedCopies = repository.listPendingDerivedCopies;
      const removeDerivedCopy = repository.removeDerivedCopy;
      assert.isDefined(recordDerivedCopies);
      assert.isDefined(listDerivedCopies);
      assert.isDefined(listPendingDerivedCopies);
      assert.isDefined(removeDerivedCopy);
      yield* repository.insert({
        access: botAccess,
        revision: makeRevision("derived-copy-memory", "bot:user", { rootId }),
      });
      yield* recordDerivedCopies({
        tenantId: botAccess.tenantId,
        revisions: [{ rootId, revisionId: AkeruMemoryId.make("derived-copy-memory") }],
        threadId: ThreadId.make("derived-thread-1"),
        createdAt: "2026-08-30T22:00:00.000Z",
      });
      yield* recordDerivedCopies({
        tenantId: botAccess.tenantId,
        revisions: [{ rootId, revisionId: AkeruMemoryId.make("derived-copy-memory") }],
        threadId: ThreadId.make("derived-thread-2"),
        createdAt: "2026-08-30T22:00:01.000Z",
      });
      assert.deepEqual(
        (yield* listDerivedCopies({ tenantId: botAccess.tenantId, rootId })).map(
          (copy) => copy.threadId,
        ),
        ["derived-thread-1", "derived-thread-2"],
      );

      const revised = makeRevision("derived-copy-memory-2", "bot:user", {
        rootId,
        revision: 2,
        supersedesId: AkeruMemoryId.make("derived-copy-memory"),
        fact: "The current fact changed.",
      });
      yield* repository.revise({ access: botAccess, expectedRevision: 1, revision: revised });
      assert.deepEqual(
        (yield* listPendingDerivedCopies()).map((copy) => copy.threadId),
        ["derived-thread-1", "derived-thread-2"],
      );
      yield* recordDerivedCopies({
        tenantId: botAccess.tenantId,
        revisions: [{ rootId, revisionId: revised.id }],
        threadId: ThreadId.make("derived-thread-1"),
        createdAt: "2026-08-30T22:00:01.500Z",
      });
      assert.deepEqual(
        (yield* listPendingDerivedCopies()).map((copy) => copy.threadId),
        ["derived-thread-2"],
      );

      yield* repository.tombstone({
        access: botAccess,
        rootId,
        expectedRevision: 2,
        memoryId: AkeruMemoryId.make("derived-copy-tombstone"),
        updatedAt: "2026-08-30T22:00:02.000Z",
      });
      const pending = yield* listPendingDerivedCopies();
      assert.deepEqual(
        pending.map((copy) => copy.threadId),
        ["derived-thread-1", "derived-thread-2"],
      );

      yield* removeDerivedCopy(pending[0]!);
      assert.deepEqual(
        (yield* listPendingDerivedCopies()).map((copy) => copy.threadId),
        ["derived-thread-2"],
      );
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
      const preview = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [forged],
      });
      const applied = yield* repository.applyImport!({
        access: botAccess,
        partitions,
        revisions: [forged],
        previewHash: preview.previewHash,
      });
      assert.equal(applied.imported, 1);
      const current = yield* repository.getCurrent({
        access: botAccess,
        rootId: forged.rootId,
      });
      assert.deepEqual(current.partition, {
        tenantId: botAccess.tenantId,
        scope: "bot",
        partitionId: AkeruMemoryPartitionId.make(botAccess.botId!),
      });
      assert.equal(current.visibility, "private");
      assert.equal(current.entityKind, "bot");
      assert.equal(current.entityId, AkeruMemoryEntityId.make(botAccess.botId!));
      assert.isNull(current.sourceThreadId);
      assert.equal(current.authorBotId, botAccess.botId);
      assert.equal(current.initiatingUserId, botAccess.userId);
      assert.deepEqual(current.affectedBotIds, [botAccess.botId]);
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
      const preview = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [botRevision],
      });
      yield* repository.applyImport!({
        access: botAccess,
        partitions,
        revisions: [botRevision],
        previewHash: preview.previewHash,
      });
      const current = yield* repository.getCurrent({
        access: botAccess,
        rootId: botRevision.rootId,
      });
      assert.equal(current.partition.scope, "bot");
      assert.equal(current.partition.partitionId, AkeruMemoryPartitionId.make(botAccess.botId!));
      assert.equal(current.entityKind, "bot");
    }),
  );

  it.effect("classifies identical, extending, divergent, and re-homed histories", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
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
      yield* repository.applyImport!({
        access: botAccess,
        partitions,
        revisions: [extendingFirst, second],
        previewHash: changed.previewHash,
      });

      const divergent = yield* repository.previewImport!({
        access: botAccess,
        partitions,
        revisions: [{ ...first, fact: "A divergent history." }],
      });
      assert.equal(divergent.items[0]?.classification, "conflicting");

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
      });
      assert.equal(rehome.items[0]?.classification, "conflicting");
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
      const workspaceId = deriveAkeruWorkspaceId(workspaceAccess.workspaceRoot);
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
});
