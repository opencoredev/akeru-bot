import * as Predicate from "effect/Predicate";
import {
  repositoryLayer,
  makeRevision,
  privateAccess,
  botAccess,
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
  ProjectId,
  ThreadId,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { EntityMemoryRepository } from "../Services/EntityMemoryRepository.ts";
import { resolveMemoryArchivePartitions } from "../EntityMemoryAccess.ts";
import { exportAkeruMemory } from "../MemoryExport.ts";
import { applyAkeruMemoryImport, previewAkeruMemoryImport } from "../MemoryImport.ts";
it.layer(repositoryLayer)("EntityMemoryRepository", (it) => {
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
      assert.isTrue(Predicate.isTagged(exit, "Failure"));
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
      if (Predicate.isTagged(exit, "Failure")) {
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
      assert.isTrue(Predicate.isTagged(exit, "Failure"));
    }),
  );

  it.effect("does not let another bot's archive replace a colliding private root", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const alice = privateAccess("bot-collision-alice");
      const bob = privateAccess("bot-collision-bob");
      const rootId = AkeruMemoryRootId.make("collision-root");
      const privateRevision = (access: typeof alice, id: string, fact: string) =>
        makeRevision(id, "bot", {
          rootId,
          fact,
          partition: {
            tenantId: access.tenantId,
            scope: "bot",
            partitionId: AkeruMemoryPartitionId.make(access.botId),
          },
          entityKind: "bot",
          entityId: AkeruMemoryEntityId.make(access.botId),
          sourceThreadId: access.threadId,
          authorBotId: access.botId,
          affectedBotIds: [access.botId],
        });
      yield* repository.insert({
        access: alice,
        revision: privateRevision(alice, "collision-alice", "Alice's private note."),
      });
      const partitions = yield* resolveMemoryArchivePartitions(bob, "bot");
      const revisions = [privateRevision(bob, "collision-bob", "Bob's replacement.")];
      const preview = yield* repository.previewImport!({ access: bob, partitions, revisions });
      assert.equal(preview.items[0]?.classification, "conflicting");
      const replaced = yield* repository.applyImport!({
        access: bob,
        partitions,
        revisions,
        previewHash: preview.previewHash,
        resolutions: [{ rootId, decision: "use-archive" }],
      }).pipe(Effect.exit);
      assert.isTrue(Predicate.isTagged(replaced, "Failure"));
      if (Predicate.isTagged(replaced, "Failure")) {
        assert.include(Cause.pretty(replaced.cause), "AkeruMemoryAccessDenied");
      }
      const current = yield* repository.getCurrent({ access: alice, rootId });
      assert.equal(current.fact, "Alice's private note.");
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

  it.effect("roundtrips an imported project fact moved into the receiving bot's scope", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const alice = {
        ...privateAccess("alice-private-import"),
        userId: AkeruMemoryUserId.make("alice-user"),
        projectId: ProjectId.make("project-privatize-import"),
        legacyWorkspaceOwnerProjectId: ProjectId.make("project-privatize-import"),
      };
      const bob = {
        ...privateAccess("bob-private-import"),
        projectId: alice.projectId,
        legacyWorkspaceOwnerProjectId: alice.projectId,
      };
      const rootId = AkeruMemoryRootId.make("import-privatize-root");
      const original = makeRevision("import-privatize-1", "project", {
        rootId,
        partition: {
          tenantId: alice.tenantId,
          scope: "project",
          partitionId: AkeruMemoryPartitionId.make(alice.projectId),
        },
        entityKind: "project",
        entityId: AkeruMemoryEntityId.make(alice.projectId),
        sourceThreadId: alice.threadId,
        authorBotId: alice.botId,
        initiatingUserId: alice.userId,
        affectedBotIds: [alice.botId],
        visibility: "shared",
      });
      yield* repository.insert({ access: alice, revision: original });
      const projectArchive = yield* exportAkeruMemory({
        repository,
        access: alice,
        target: "project",
        complete: true,
        createdAt: "2026-08-30T22:00:00.000Z",
        conversations: [],
      });
      yield* repository.deleteRoot({ access: alice, rootId });
      const projectPreview = yield* previewAkeruMemoryImport({
        repository,
        access: bob,
        target: "project",
        archive: projectArchive,
      });
      yield* applyAkeruMemoryImport({
        repository,
        access: bob,
        target: "project",
        archive: projectArchive,
        previewHash: projectPreview.previewHash,
      });
      const imported = yield* repository.getCurrent({ access: bob, rootId });
      assert.equal(imported.authorBotId, alice.botId);
      assert.equal(imported.initiatingUserId, alice.userId);
      assert.deepEqual(imported.affectedBotIds, [alice.botId]);
      const moved = yield* repository.applyMutation({
        access: bob,
        mutation: {
          operation: "fact.scope",
          memoryId: rootId,
          expectedRevision: imported.revision,
          scope: "bot",
        },
        memoryId: AkeruMemoryId.make("import-privatize-2"),
        updatedAt: "2026-08-30T22:30:00.000Z",
        sharedProjectApproval: "approved",
      });
      const botArchive = yield* exportAkeruMemory({
        repository,
        access: bob,
        target: "bot",
        complete: true,
        createdAt: "2026-08-30T23:00:00.000Z",
        conversations: [],
      });
      yield* repository.deleteRoot({ access: bob, rootId });
      const botPreview = yield* previewAkeruMemoryImport({
        repository,
        access: bob,
        target: "bot",
        archive: botArchive,
      });
      assert.deepEqual(
        botPreview.items.map((item) => item.classification),
        ["new"],
      );
      const result = yield* applyAkeruMemoryImport({
        repository,
        access: bob,
        target: "bot",
        archive: botArchive,
        previewHash: botPreview.previewHash,
      });
      assert.equal(result.imported, 1);
      const restored = yield* repository.getCurrent({ access: bob, rootId });
      assert.equal(restored.id, moved!.id);
      assert.equal(restored.partition.scope, "bot");
      assert.equal(restored.authorBotId, bob.botId);
      assert.equal(restored.initiatingUserId, bob.userId);
      assert.deepEqual(restored.affectedBotIds, [bob.botId]);
      assert.equal(restored.sourceThreadId, alice.threadId);
      const history = yield* repository.listHistory({ access: bob, rootId });
      assert.equal(history.length, 2);
      assert.equal(history[1]!.partition.scope, "project");
      assert.equal(history[1]!.authorBotId, alice.botId);
      assert.equal(history[1]!.initiatingUserId, alice.userId);
      assert.deepEqual(history[1]!.affectedBotIds, [alice.botId]);
    }),
  );

  it.effect("roundtrips another bot's project export without a moved fact's private prefix", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const projectId = ProjectId.make("project-private-history");
      const accessFor = (botId: string) =>
        ({
          ...privateAccess(botId),
          projectId,
          legacyWorkspaceOwnerProjectId: projectId,
        }) as const;
      const alice = accessFor("bot-private-history-alice");
      const bob = accessFor("bot-private-history-bob");
      const rootId = AkeruMemoryRootId.make("private-history-root");
      yield* repository.insert({
        access: alice,
        revision: makeRevision("private-history-1", "bot", {
          rootId,
          fact: "Alice's private deploy token is hunter2.",
          partition: {
            tenantId: alice.tenantId,
            scope: "bot",
            partitionId: AkeruMemoryPartitionId.make(alice.botId),
          },
          entityKind: "bot",
          entityId: AkeruMemoryEntityId.make(alice.botId),
          sourceThreadId: alice.threadId,
          authorBotId: alice.botId,
          affectedBotIds: [alice.botId],
        }),
      });
      yield* repository.applyMutation({
        access: alice,
        mutation: {
          operation: "fact.edit",
          memoryId: rootId,
          expectedRevision: 1,
          fact: "Deploys use the shared release checklist.",
        },
        memoryId: AkeruMemoryId.make("private-history-2"),
        updatedAt: "2026-08-30T22:30:00.000Z",
        sharedProjectApproval: "approved",
      });
      yield* repository.applyMutation({
        access: alice,
        mutation: {
          operation: "fact.scope",
          memoryId: rootId,
          expectedRevision: 2,
          scope: "project",
        },
        memoryId: AkeruMemoryId.make("private-history-3"),
        updatedAt: "2026-08-30T22:31:00.000Z",
        sharedProjectApproval: "approved",
      });
      yield* repository.applyMutation({
        access: alice,
        mutation: {
          operation: "fact.edit",
          memoryId: rootId,
          expectedRevision: 3,
          fact: "Deploys use the shared release checklist and require approval.",
        },
        memoryId: AkeruMemoryId.make("private-history-4"),
        updatedAt: "2026-08-30T22:32:00.000Z",
        sharedProjectApproval: "approved",
      });
      const exportAs = (access: typeof alice) =>
        exportAkeruMemory({
          repository,
          access,
          target: "project",
          complete: true,
          createdAt: "2026-08-30T23:00:00.000Z",
          conversations: [],
        });

      const bobArchive = yield* exportAs(bob);
      if (bobArchive.schemaVersion !== 2) return assert.fail("Expected a V2 archive.");
      assert.deepEqual(
        bobArchive.revisions.map(({ revision }) => revision.revision),
        (yield* repository.listHistory({ access: bob, rootId }))
          .map((revision) => revision.revision)
          .toReversed(),
      );
      assert.deepEqual(
        bobArchive.revisions.map(({ revision }) => revision.revision),
        [3, 4],
      );
      assert.isFalse(bobArchive.files.some((file) => file.content.includes("hunter2")));

      const aliceArchive = yield* exportAs(alice);
      if (aliceArchive.schemaVersion !== 2) return assert.fail("Expected a V2 archive.");
      assert.deepEqual(
        aliceArchive.revisions.map(({ revision }) => revision.revision),
        [1, 2, 3, 4],
      );
      const existingPreview = yield* previewAkeruMemoryImport({
        repository,
        access: bob,
        target: "project",
        archive: bobArchive,
      });
      assert.deepEqual(
        existingPreview.items.map((item) => item.classification),
        ["conflicting"],
      );
      const replaceAlice = yield* applyAkeruMemoryImport({
        repository,
        access: bob,
        target: "project",
        archive: bobArchive,
        previewHash: existingPreview.previewHash,
        resolutions: [{ rootId, decision: "use-archive" }],
      }).pipe(Effect.exit);
      assert.isTrue(Predicate.isTagged(replaceAlice, "Failure"));
      assert.deepEqual(
        (yield* repository.listHistory({ access: alice, rootId })).map(
          (revision) => revision.revision,
        ),
        [4, 3, 2, 1],
      );
      yield* repository.deleteRoot({ access: alice, rootId });
      const preview = yield* previewAkeruMemoryImport({
        repository,
        access: bob,
        target: "project",
        archive: bobArchive,
      });
      assert.deepEqual(
        preview.items.map((item) => item.classification),
        ["new"],
      );
      const result = yield* applyAkeruMemoryImport({
        repository,
        access: bob,
        target: "project",
        archive: bobArchive,
        previewHash: preview.previewHash,
      });
      assert.equal(result.imported, 1);
      const assertRestored = Effect.gen(function* () {
        const restored = yield* repository.getCurrent({ access: bob, rootId });
        assert.equal(restored.id, "private-history-4");
        assert.equal(restored.revision, 2);
        assert.equal(restored.partition.scope, "project");
        assert.equal(restored.partition.partitionId, AkeruMemoryPartitionId.make(projectId));
        assert.equal(restored.entityKind, "project");
        assert.equal(restored.entityId, AkeruMemoryEntityId.make(projectId));
        assert.equal(restored.visibility, "shared");
        assert.equal(restored.authorBotId, alice.botId);
        assert.equal(restored.sourceThreadId, alice.threadId);
        assert.deepEqual(restored.affectedBotIds, [alice.botId]);
        assert.equal(
          restored.fact,
          "Deploys use the shared release checklist and require approval.",
        );
        const history = (yield* repository.listHistory({ access: bob, rootId })).toReversed();
        assert.deepEqual(
          history.map(({ id, revision, supersedesId, supersededById, partition }) => ({
            id: String(id),
            revision,
            supersedesId: supersedesId === null ? null : String(supersedesId),
            supersededById: supersededById === null ? null : String(supersededById),
            scope: partition.scope,
          })),
          [
            {
              id: "private-history-3",
              revision: 1,
              supersedesId: null,
              supersededById: "private-history-4",
              scope: "project",
            },
            {
              id: "private-history-4",
              revision: 2,
              supersedesId: "private-history-3",
              supersededById: null,
              scope: "project",
            },
          ],
        );
      });
      yield* assertRestored;
      yield* repository.applyMutation({
        access: bob,
        mutation: {
          operation: "fact.edit",
          memoryId: rootId,
          expectedRevision: 2,
          fact: "A divergent local edit.",
        },
        memoryId: AkeruMemoryId.make("private-history-local"),
        updatedAt: "2026-08-30T23:01:00.000Z",
        sharedProjectApproval: "approved",
      });
      const conflicting = yield* previewAkeruMemoryImport({
        repository,
        access: bob,
        target: "project",
        archive: bobArchive,
      });
      assert.deepEqual(
        conflicting.items.map((item) => item.classification),
        ["conflicting"],
      );
      yield* applyAkeruMemoryImport({
        repository,
        access: bob,
        target: "project",
        archive: bobArchive,
        previewHash: conflicting.previewHash,
        resolutions: [{ rootId, decision: "use-archive" }],
      });
      yield* assertRestored;
      const restoredArchive = yield* exportAs(bob);
      const restoredPreview = yield* previewAkeruMemoryImport({
        repository,
        access: bob,
        target: "project",
        archive: restoredArchive,
      });
      assert.deepEqual(
        restoredPreview.items.map((item) => item.classification),
        ["skipped"],
      );
    }),
  );

  it.effect("restores a pending project fact from a complete export for review", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const access = { ...botAccess, projectId: ProjectId.make("project-pending-archive") };
      const rootId = AkeruMemoryRootId.make("pending-archive-roundtrip-root");
      const encodeJson = (value: unknown) => JSON.stringify(value) as string;
      const pending = makeRevision("pending-archive-roundtrip-1", "project", {
        rootId,
        partition: {
          tenantId: access.tenantId,
          scope: "project",
          partitionId: AkeruMemoryPartitionId.make(access.projectId),
        },
        entityKind: "project",
        entityId: AkeruMemoryEntityId.make(access.projectId),
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
      const archive = yield* exportAkeruMemory({
        repository,
        access: access,
        target: "project",
        complete: true,
        createdAt: "2026-08-30T23:00:00.000Z",
        conversations: [],
      });
      assert.isTrue(archive.revisions.some(({ revision }) => revision.rootId === rootId));
      yield* repository.deleteRoot({ access: access, rootId });
      const preview = yield* previewAkeruMemoryImport({
        repository,
        access: access,
        target: "project",
        archive,
      });
      yield* applyAkeruMemoryImport({
        repository,
        access: access,
        target: "project",
        archive,
        previewHash: preview.previewHash,
      });

      const restored = yield* repository.getCurrent({ access: access, rootId });
      assert.equal(restored.approvalState, "pending");
      const approved = yield* repository.applyMutation({
        access: access,
        mutation: {
          operation: "fact.decide",
          memoryId: rootId,
          expectedRevision: restored.revision,
          decision: "approve",
        },
        memoryId: AkeruMemoryId.make("pending-archive-roundtrip-2"),
        updatedAt: "2026-08-30T23:01:00.000Z",
        sharedProjectApproval: "approved",
      });
      assert.equal(approved!.approvalState, "approved");
    }),
  );
});
