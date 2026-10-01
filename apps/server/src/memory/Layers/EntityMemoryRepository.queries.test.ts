// @effect-diagnostics nodeBuiltinImport:off
import * as Predicate from "effect/Predicate";
import {
  repositoryLayer,
  makeRevision,
  insert,
  botAccess,
} from "./testUtils/entityMemoryRepository.ts";
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
  AkeruMemoryUserId,
  BotId,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import {
  EntityMemoryConflictError,
  EntityMemoryRepository,
} from "../Services/EntityMemoryRepository.ts";
import { MemoryRevisionWriteLockLive } from "../Services/MemoryRevisionWriteLock.ts";
import { EntityMemoryRepositoryLive } from "./EntityMemoryRepository.ts";
import { resolveMemoryArchivePartitions } from "../EntityMemoryAccess.ts";

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

it.layer(repositoryLayer)("EntityMemoryRepository", (it) => {
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
      assert.isTrue(exits.every((exit) => Predicate.isTagged(exit, "Failure")));
      assert.equal((yield* repository.getCurrent({ access: botAccess, rootId })).id, first.id);
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
      assert.isTrue(Predicate.isTagged(exit, "Failure"));
      if (Predicate.isTagged(exit, "Failure")) {
        assert.instanceOf(Cause.squash(exit.cause), EntityMemoryConflictError);
      }
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
      assert.isTrue(Predicate.isTagged(exit, "Failure"));
    }),
  );

  it.effect("rejects gaps and broken links after a redacted project history prefix", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const partitions = yield* resolveMemoryArchivePartitions(botAccess, "project");
      const rootId = AkeruMemoryRootId.make("redacted-invalid-chain-root");
      const first = makeRevision("redacted-invalid-chain-3", "project", {
        rootId,
        revision: 3,
        partition: {
          tenantId: botAccess.tenantId,
          scope: "project",
          partitionId: AkeruMemoryPartitionId.make(botAccess.projectId),
        },
        entityKind: "project",
        entityId: AkeruMemoryEntityId.make(botAccess.projectId),
        visibility: "shared",
        supersedesId: AkeruMemoryId.make("redacted-private-2"),
        supersededById: AkeruMemoryId.make("redacted-invalid-chain-4"),
      });
      const second = {
        ...first,
        id: AkeruMemoryId.make("redacted-invalid-chain-4"),
        revision: 4,
        supersedesId: first.id,
        supersededById: null,
      };
      const invalidHistories = [
        [first, { ...second, revision: 5 }],
        [first, { ...second, supersedesId: AkeruMemoryId.make("missing-project-revision") }],
        [first],
      ];
      for (const revisions of invalidHistories) {
        const preview = yield* repository.previewImport({
          access: botAccess,
          partitions,
          revisions,
        });
        assert.equal(preview.items[0]?.classification, "conflicting");
        assert.equal(preview.items[0]?.reason, "The archive revision chain is invalid.");
        const exit = yield* repository
          .applyImport({
            access: botAccess,
            partitions,
            revisions,
            previewHash: preview.previewHash,
            resolutions: [{ rootId, decision: "use-archive" }],
          })
          .pipe(Effect.exit);
        assert.equal(exit._tag, "Failure");
      }
      const missing = yield* repository.getCurrent({ access: botAccess, rootId }).pipe(Effect.flip);
      assert.equal(missing._tag, "EntityMemoryNotFoundError");
    }),
  );
});
