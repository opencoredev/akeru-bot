import * as Predicate from "effect/Predicate";
import {
  repositoryLayer,
  makeRevision,
  privateAccess,
  insert,
  botAccess,
  sharedAccess,
} from "./testUtils/entityMemoryRepository.ts";
import { assert, it } from "@effect/vitest";
import {
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryPartitionId,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  EntityMemoryConflictError,
  EntityMemoryRepository,
} from "../Services/EntityMemoryRepository.ts";
import { deriveAkeruWorkspaceId, resolveMemoryArchivePartitions } from "../EntityMemoryAccess.ts";

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

      assert.isTrue(exits.every((exit) => Predicate.isTagged(exit, "Failure")));
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

      assert.isTrue(Predicate.isTagged(stale, "Failure"));

      if (Predicate.isTagged(stale, "Failure")) {
        assert.instanceOf(Cause.squash(stale.cause), EntityMemoryConflictError);
      }
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

      assert.isTrue(Predicate.isTagged(exit, "Failure"));
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

      assert.isTrue(Predicate.isTagged(resurrection, "Failure"));

      if (Predicate.isTagged(resurrection, "Failure")) {
        assert.instanceOf(Cause.squash(resurrection.cause), EntityMemoryConflictError);
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

      assert.isTrue(Predicate.isTagged(exit, "Failure"));
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

      assert.isTrue(Predicate.isTagged(exit, "Failure"));
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

      assert.isTrue(Predicate.isTagged(unresolved, "Failure"));
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

      assert.isTrue(Predicate.isTagged(rehome, "Failure"));
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

      assert.isTrue(Predicate.isTagged(denied, "Failure"));
    }),
  );
});
