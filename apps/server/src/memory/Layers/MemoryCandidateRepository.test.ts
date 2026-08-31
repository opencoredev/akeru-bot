// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AkeruMemoryCandidateId,
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryPartitionId,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  GroupId,
  ProjectId,
  ThreadId,
  type AkeruMemoryCandidate,
  type AkeruMemoryRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { EntityMemoryRepository } from "../Services/EntityMemoryRepository.ts";
import { MemoryCandidateRepository } from "../Services/MemoryCandidateRepository.ts";
import {
  MemoryRevisionWriteLock,
  MemoryRevisionWriteLockLive,
} from "../Services/MemoryRevisionWriteLock.ts";
import { EntityMemoryRepositoryLive } from "./EntityMemoryRepository.ts";
import { MemoryCandidateRepositoryLive } from "./MemoryCandidateRepository.ts";

const repositoriesLive = Layer.mergeAll(
  EntityMemoryRepositoryLive,
  MemoryCandidateRepositoryLive,
).pipe(Layer.provide(MemoryRevisionWriteLockLive));

const layer = Layer.mergeAll(
  repositoriesLive.pipe(Layer.provide(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);

const access = {
  tenantId: AkeruMemoryTenantId.make("local"),
  userId: AkeruMemoryUserId.make("owner"),
  threadId: ThreadId.make("thread-candidate"),
  projectId: ProjectId.make("project-candidate"),
  workspaceRoot: "/workspace/candidate",
  botId: BotId.make("bot-candidate"),
  groupId: null,
  respondingBotId: null,
  groupMemberBotIds: [],
} as const;

const candidate = (id: string): AkeruMemoryCandidate => ({
  candidateId: AkeruMemoryCandidateId.make(id),
  tenantId: access.tenantId,
  initiatingUserId: access.userId,
  sourceThreadId: access.threadId,
  sourceMessageId: null,
  authorBotId: access.botId,
  fact: "The project uses npm.",
  scope: "private",
  sensitive: false,
  confidence: 0.9,
  affectedBotIds: [access.botId],
  pendingUpdate: null,
  status: "pending",
  createdAt: "2026-08-30T20:00:00.000Z",
  decidedAt: null,
  decidedMemoryRootId: null,
});

it("preserves candidates and decision receipts after repository restart", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "akeru-candidate-restart-"),
    );
    const dbPath = NodePath.join(directory, "state.sqlite");
    const persistence = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
    const restartedLayer = Layer.mergeAll(
      repositoriesLive.pipe(Layer.provide(persistence)),
      persistence,
    );
    const candidateId = AkeruMemoryCandidateId.make("candidate-restart");
    const revision = approvedRevision("candidate-restart");
    yield* Effect.gen(function* () {
      const repository = yield* MemoryCandidateRepository;
      yield* repository.create({ access, candidate: candidate(candidateId) });
    }).pipe(Effect.provide(restartedLayer));
    yield* Effect.gen(function* () {
      const repository = yield* MemoryCandidateRepository;
      assert.deepEqual(
        (yield* repository.listPending({ access })).map((row) => row.candidateId),
        [candidateId],
      );
      yield* repository.approve({
        access,
        candidateId,
        revision,
        receiptId: "receipt-restart",
        decidedAt: revision.updatedAt,
      });
    }).pipe(Effect.provide(restartedLayer));
    yield* Effect.gen(function* () {
      const candidates = yield* MemoryCandidateRepository;
      const memory = yield* EntityMemoryRepository;
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* candidates.listPending({ access })).length, 0);
      assert.equal(
        (yield* memory.getCurrent({ access, rootId: revision.rootId })).rootId,
        revision.rootId,
      );
      const receipts = yield* sql<{
        receipt_id: string;
        status: string;
        memory_root_id: string | null;
      }>`SELECT receipt_id, status, memory_root_id
         FROM akeru_memory_decision_receipts WHERE receipt_id = ${"receipt-restart"}`;
      assert.deepEqual(receipts, [
        {
          receipt_id: "receipt-restart",
          status: "approved",
          memory_root_id: revision.rootId,
        },
      ]);
    }).pipe(Effect.provide(restartedLayer));
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }));

it("shares one revision write lock between both repositories", () => {
  let constructions = 0;
  const countedLock = Layer.effect(
    MemoryRevisionWriteLock,
    Effect.gen(function* () {
      constructions++;
      return yield* Semaphore.make(1);
    }),
  );
  const countedRepositories = Layer.mergeAll(
    EntityMemoryRepositoryLive,
    MemoryCandidateRepositoryLive,
  ).pipe(Layer.provide(countedLock), Layer.provide(SqlitePersistenceMemory));

  return Effect.gen(function* () {
    yield* EntityMemoryRepository;
    yield* MemoryCandidateRepository;
    assert.equal(constructions, 1);
  }).pipe(Effect.provide(countedRepositories));
});

const approvedRevision = (id: string): AkeruMemoryRevision => ({
  id: AkeruMemoryId.make(`${id}-revision`),
  rootId: AkeruMemoryRootId.make(`${id}-root`),
  revision: 1,
  partition: {
    tenantId: access.tenantId,
    scope: "project",
    partitionId: AkeruMemoryPartitionId.make(access.projectId),
  },
  entityKind: "project",
  entityId: AkeruMemoryEntityId.make(access.projectId),
  kind: "fact",
  value: {},
  fact: "The project uses Bun.",
  sourceThreadId: access.threadId,
  sourceMessageId: null,
  authorBotId: access.botId,
  initiatingUserId: access.userId,
  createdAt: "2026-08-30T20:01:00.000Z",
  confirmedAt: "2026-08-30T20:01:00.000Z",
  updatedAt: "2026-08-30T20:01:00.000Z",
  confidence: 1,
  approvalState: "approved",
  supersedesId: null,
  supersededById: null,
  visibility: "shared",
  deletionState: "active",
  pinned: false,
  sensitive: false,
  affectedBotIds: [access.botId],
});

it.layer(layer)("MemoryCandidateRepository", (it) => {
  it.effect("creates and rejects a pending candidate with a durable receipt", () =>
    Effect.gen(function* () {
      const repository = yield* MemoryCandidateRepository;
      yield* repository.create({ access, candidate: candidate("candidate-reject") });
      assert.equal((yield* repository.listPending({ access })).length, 1);

      const receipt = yield* repository.reject({
        access,
        candidateId: AkeruMemoryCandidateId.make("candidate-reject"),
        receiptId: "receipt-reject",
        decidedAt: "2026-08-30T20:02:00.000Z",
      });
      assert.equal(receipt.status, "rejected");
      assert.isNull(receipt.memoryRootId);
      assert.equal((yield* repository.listPending({ access })).length, 0);
    }),
  );

  it.effect("approves an edited scope and fact in one transaction", () =>
    Effect.gen(function* () {
      const candidates = yield* MemoryCandidateRepository;
      const memory = yield* EntityMemoryRepository;
      yield* candidates.create({ access, candidate: candidate("candidate-approve") });
      const revision = approvedRevision("candidate-approve");

      const receipt = yield* candidates.approve({
        access,
        candidateId: AkeruMemoryCandidateId.make("candidate-approve"),
        revision,
        receiptId: "receipt-approve",
        decidedAt: revision.updatedAt,
      });
      assert.equal(receipt.status, "approved");
      assert.equal(receipt.scope, "project");
      assert.equal(receipt.fact, "The project uses Bun.");
      assert.equal(
        (yield* memory.getCurrent({ access, rootId: revision.rootId })).rootId,
        revision.rootId,
      );

      const replay = yield* candidates
        .approve({
          access,
          candidateId: AkeruMemoryCandidateId.make("candidate-approve"),
          revision,
          receiptId: "receipt-replay",
          decidedAt: revision.updatedAt,
        })
        .pipe(Effect.exit);
      assert.isTrue(replay._tag === "Failure");
    }),
  );

  it.effect("coordinates candidate approval with direct revision writers", () =>
    Effect.gen(function* () {
      const candidates = yield* MemoryCandidateRepository;
      const memory = yield* EntityMemoryRepository;
      const candidateId = AkeruMemoryCandidateId.make("candidate-concurrent-head");
      const approved = approvedRevision("candidate-concurrent-head");
      const direct = { ...approved, id: AkeruMemoryId.make("direct-concurrent-head") };
      yield* candidates.create({ access, candidate: candidate(candidateId) });

      const exits = yield* Effect.all(
        [
          Effect.exit(
            candidates.approve({
              access,
              candidateId,
              revision: approved,
              receiptId: "receipt-concurrent-head",
              decidedAt: approved.updatedAt,
            }),
          ),
          Effect.exit(memory.insert({ access, revision: direct })),
        ],
        { concurrency: "unbounded" },
      );
      const failures = exits.filter((exit) => exit._tag === "Failure");
      assert.equal(failures.length, 1);
      const error = Cause.squash(failures[0]!.cause as Cause.Cause<unknown>);
      assert.include(
        ["EntityMemoryConflictError", "MemoryCandidateConflictError"],
        (error as { readonly _tag?: string })._tag,
      );
      assert.equal((yield* memory.listHistory({ access, rootId: approved.rootId })).length, 1);
    }),
  );

  it.effect("rejects candidates whose affected bots were supplied by the caller", () =>
    Effect.gen(function* () {
      const repository = yield* MemoryCandidateRepository;
      const exit = yield* repository
        .create({
          access,
          candidate: {
            ...candidate("candidate-forged"),
            affectedBotIds: [BotId.make("another-bot")],
          },
        })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("rejects approval when the entity kind does not match the selected scope", () =>
    Effect.gen(function* () {
      const repository = yield* MemoryCandidateRepository;
      const candidateId = AkeruMemoryCandidateId.make("candidate-wrong-entity-kind");
      yield* repository.create({ access, candidate: candidate(candidateId) });
      const revision = {
        ...approvedRevision("candidate-wrong-entity-kind"),
        entityKind: "user" as const,
      };

      const exit = yield* repository
        .approve({
          access,
          candidateId,
          revision,
          receiptId: "receipt-wrong-entity-kind",
          decidedAt: revision.updatedAt,
        })
        .pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
      assert.equal((yield* repository.listPending({ access })).length, 1);
      yield* repository.approve({
        access,
        candidateId,
        revision: approvedRevision("candidate-wrong-entity-kind"),
        receiptId: "receipt-correct-entity-kind",
        decidedAt: revision.updatedAt,
      });
    }),
  );

  it.effect("hides pending candidates after the responding bot loses group access", () =>
    Effect.gen(function* () {
      const repository = yield* MemoryCandidateRepository;
      const groupAccess = {
        ...access,
        groupId: GroupId.make("group-candidate"),
        respondingBotId: access.botId,
        groupMemberBotIds: [access.botId],
      } as const;
      yield* repository.create({
        access: groupAccess,
        candidate: { ...candidate("candidate-revoked"), scope: "group" },
      });

      assert.equal((yield* repository.listPending({ access: groupAccess })).length, 1);
      assert.equal(
        (yield* repository.listPending({
          access: { ...groupAccess, groupMemberBotIds: [] },
        })).length,
        0,
      );
    }),
  );
});
