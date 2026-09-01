import { assert, it } from "@effect/vitest";
import {
  AkeruMemoryCandidateId,
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { resolveAuthorizedMemoryPartitions } from "./EntityMemoryAccess.ts";
import { EntityMemoryRepositoryLive } from "./Layers/EntityMemoryRepository.ts";
import { MemoryCandidateRepositoryLive } from "./Layers/MemoryCandidateRepository.ts";
import {
  createMemoryToolHandlers,
  decideMemoryCandidate,
  type AkeruMemoryToolHandler,
  type AkeruMemoryToolId,
} from "./MemoryToolHandlers.ts";
import { EntityMemoryRepository } from "./Services/EntityMemoryRepository.ts";
import { MemoryCandidateRepository } from "./Services/MemoryCandidateRepository.ts";
import { MemoryRevisionWriteLockLive } from "./Services/MemoryRevisionWriteLock.ts";

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
  threadId: ThreadId.make("thread-memory-tools"),
  projectId: ProjectId.make("project-memory-tools"),
  workspaceRoot: "/workspace/memory-tools",
  botId: BotId.make("bot-memory-tools"),
  groupId: null,
  respondingBotId: null,
  groupMemberBotIds: [],
} as const;

const execute = (toolId: AkeruMemoryToolId, handler: AkeruMemoryToolHandler, input: unknown) =>
  handler({
    threadId: access.threadId,
    toolId,
    toolCallId: `call-${toolId}`,
    input,
    approvalMode: "require-grant",
  });

it.layer(layer)("MemoryToolHandlers", (it) => {
  it.effect("writes private facts directly without creating an approval orphan", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const candidates = yield* MemoryCandidateRepository;
      const handlers = createMemoryToolHandlers(repository, candidates, access);

      const saved = yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "The user prefers Vim.",
          scope: "private",
        }),
      );

      assert.equal((saved as { revision: number }).revision, 1);
      assert.deepEqual(yield* candidates.listPending({ access }), []);
      assert.equal((yield* repository.listCurrent({ access })).length, 1);
    }),
  );

  it.effect("leaves shared and sensitive saves pending with no current revision", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const candidates = yield* MemoryCandidateRepository;
      const handlers = createMemoryToolHandlers(repository, candidates, access);
      const currentCount = (yield* repository.listCurrent({ access })).length;
      const pendingCount = (yield* candidates.listPending({ access })).length;

      yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "The project uses Bun.",
          scope: "project",
        }),
      );
      yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "The private token is alpha.",
          scope: "private",
          sensitive: true,
        }),
      );

      assert.equal((yield* candidates.listPending({ access })).length, pendingCount + 2);
      assert.equal((yield* repository.listCurrent({ access })).length, currentCount);
    }),
  );

  it.effect("enforces delegated memory scopes on reads and writes", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const candidates = yield* MemoryCandidateRepository;
      const unrestricted = createMemoryToolHandlers(repository, candidates, access);
      yield* Effect.promise(() =>
        execute("remember", unrestricted.remember, {
          fact: "Private delegated detail.",
          scope: "private",
        }),
      );
      const restricted = createMemoryToolHandlers(repository, candidates, access, undefined, [
        "project",
      ]);
      const recalled = (yield* Effect.promise(() =>
        execute("recall_memory", restricted.recall_memory, { query: "Private delegated detail" }),
      )) as ReadonlyArray<{ readonly scope: string }>;
      assert.deepEqual(recalled, []);
      const rejected = yield* Effect.promise(() =>
        execute("remember", restricted.remember, {
          fact: "Another private detail.",
          scope: "private",
        }).then(
          () => false,
          () => true,
        ),
      );
      assert.isTrue(rejected);
    }),
  );

  it.effect("updates private non-sensitive facts directly", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const candidates = yield* MemoryCandidateRepository;
      let invalidations = 0;
      const handlers = createMemoryToolHandlers(repository, candidates, access, () => {
        invalidations += 1;
      });
      const pendingCount = (yield* candidates.listPending({ access })).length;
      const saved = (yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "Use npm.",
          scope: "private",
        }),
      )) as { rootId: string };

      const updated = (yield* Effect.promise(() =>
        execute("update_memory", handlers.update_memory, {
          memoryId: saved.rootId,
          expectedRevision: 1,
          fact: "Use Bun.",
          scope: "private",
        }),
      )) as { fact: string; revision: number };

      assert.equal(updated.fact, "Use Bun.");
      assert.equal(updated.revision, 2);
      assert.equal(invalidations, 1);
      assert.equal((yield* candidates.listPending({ access })).length, pendingCount);
    }),
  );

  it.effect("keeps approved private updates in an imported user partition", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const candidates = yield* MemoryCandidateRepository;
      const handlers = createMemoryToolHandlers(repository, candidates, access);
      const partition = (yield* resolveAuthorizedMemoryPartitions(access)).find(
        (candidate) => candidate.scope === "user",
      );
      assert.isDefined(partition);
      const rootId = AkeruMemoryRootId.make("imported-user-root");
      yield* repository.insert({
        access,
        revision: {
          id: AkeruMemoryId.make("imported-user-revision"),
          rootId,
          revision: 1,
          partition,
          entityKind: "user",
          entityId: AkeruMemoryEntityId.make(access.userId),
          kind: "fact",
          value: {},
          fact: "Use npm.",
          sourceThreadId: access.threadId,
          sourceMessageId: null,
          authorBotId: access.botId,
          initiatingUserId: access.userId,
          createdAt: "2026-08-31T00:00:00.000Z",
          confirmedAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
          confidence: 1,
          approvalState: "approved",
          supersedesId: null,
          supersededById: null,
          visibility: "private",
          deletionState: "active",
          pinned: false,
          sensitive: false,
          affectedBotIds: [access.botId],
        },
      });
      const pending = (yield* Effect.promise(() =>
        execute("update_memory", handlers.update_memory, {
          memoryId: rootId,
          expectedRevision: 1,
          fact: "Use Bun.",
          scope: "private",
        }),
      )) as { candidateId: string };

      yield* Effect.promise(() =>
        decideMemoryCandidate(repository, candidates, access, {
          candidateId: AkeruMemoryCandidateId.make(pending.candidateId),
          decision: "approve",
        }),
      );
      const current = yield* repository.getCurrent({ access, rootId });
      assert.equal(current.partition.scope, "user");
      assert.equal(current.partition.partitionId, partition.partitionId);
      assert.equal(current.fact, "Use Bun.");
    }),
  );

  it.effect("approves or rejects each candidate once", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const candidates = yield* MemoryCandidateRepository;
      const handlers = createMemoryToolHandlers(repository, candidates, access);
      const currentCount = (yield* repository.listCurrent({ access })).length;
      const pendingCount = (yield* candidates.listPending({ access })).length;
      const approvedCandidate = (yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "The project uses Bun.",
          scope: "project",
        }),
      )) as { candidateId: string };
      const rejectedCandidate = (yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "Temporary note.",
          scope: "project",
        }),
      )) as { candidateId: string };

      const approved = yield* Effect.promise(() =>
        decideMemoryCandidate(repository, candidates, access, {
          candidateId: AkeruMemoryCandidateId.make(approvedCandidate.candidateId),
          decision: "approve",
        }),
      );
      const rejected = yield* Effect.promise(() =>
        decideMemoryCandidate(repository, candidates, access, {
          candidateId: AkeruMemoryCandidateId.make(rejectedCandidate.candidateId),
          decision: "reject",
        }),
      );

      assert.equal(approved.status, "approved");
      assert.equal(rejected.status, "rejected");
      assert.equal((yield* repository.listCurrent({ access })).length, currentCount + 1);
      assert.equal((yield* candidates.listPending({ access })).length, pendingCount);
      const repeated = yield* Effect.promise(() =>
        decideMemoryCandidate(repository, candidates, access, {
          candidateId: AkeruMemoryCandidateId.make(approvedCandidate.candidateId),
          decision: "approve",
        }).then(
          () => false,
          () => true,
        ),
      );
      assert.isTrue(repeated);
    }),
  );

  it.effect("keeps a pending update at its expected revision until approval", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const candidates = yield* MemoryCandidateRepository;
      let invalidations = 0;
      const handlers = createMemoryToolHandlers(repository, candidates, access, () => {
        invalidations += 1;
      });
      const saved = (yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "Use npm.",
          scope: "private",
        }),
      )) as { rootId: string };
      const pending = (yield* Effect.promise(() =>
        execute("update_memory", handlers.update_memory, {
          memoryId: saved.rootId,
          expectedRevision: 1,
          fact: "Use Bun.",
          scope: "project",
        }),
      )) as { candidateId: string };

      const storedCandidate = (yield* candidates.listPending({ access })).find(
        (candidate) => candidate.candidateId === pending.candidateId,
      );
      assert.equal(storedCandidate?.pendingUpdate?.rootId, saved.rootId);
      assert.equal(storedCandidate?.pendingUpdate?.expectedRevision, 1);

      const before = yield* repository.getCurrent({
        access,
        rootId: AkeruMemoryRootId.make(saved.rootId),
      });
      assert.equal(before.revision, 1);
      assert.equal(invalidations, 0);
      yield* Effect.promise(() =>
        decideMemoryCandidate(
          repository,
          { ...candidates },
          access,
          {
            candidateId: AkeruMemoryCandidateId.make(pending.candidateId),
            decision: "approve",
          },
          () => {
            invalidations += 1;
          },
        ),
      );
      const after = yield* repository.getCurrent({
        access,
        rootId: AkeruMemoryRootId.make(saved.rootId),
      });
      assert.equal(after.revision, 2);
      assert.equal(after.fact, "Use Bun.");
      assert.equal(invalidations, 1);
    }),
  );

  it.effect("requires review when an update removes shared or sensitive policy", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const candidates = yield* MemoryCandidateRepository;
      const handlers = createMemoryToolHandlers(repository, candidates, access);
      const sharedCandidate = (yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "Shared fact.",
          scope: "project",
        }),
      )) as { candidateId: string };
      const sensitiveCandidate = (yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "Sensitive fact.",
          scope: "private",
          sensitive: true,
        }),
      )) as { candidateId: string };
      const shared = yield* Effect.promise(() =>
        decideMemoryCandidate(repository, candidates, access, {
          candidateId: AkeruMemoryCandidateId.make(sharedCandidate.candidateId),
          decision: "approve",
        }),
      );
      const sensitive = yield* Effect.promise(() =>
        decideMemoryCandidate(repository, candidates, access, {
          candidateId: AkeruMemoryCandidateId.make(sensitiveCandidate.candidateId),
          decision: "approve",
        }),
      );

      const privateUpdate = yield* Effect.promise(() =>
        execute("update_memory", handlers.update_memory, {
          memoryId: shared.memoryRootId,
          expectedRevision: 1,
          fact: "Private fact.",
          scope: "private",
        }),
      );
      const nonSensitiveUpdate = yield* Effect.promise(() =>
        execute("update_memory", handlers.update_memory, {
          memoryId: sensitive.memoryRootId,
          expectedRevision: 1,
          fact: "Non-sensitive fact.",
          scope: "private",
          sensitive: false,
        }),
      );

      assert.equal((privateUpdate as { status: string }).status, "pending");
      assert.equal((nonSensitiveUpdate as { status: string }).status, "pending");
      assert.equal(
        (yield* repository.getCurrent({
          access,
          rootId: AkeruMemoryRootId.make(String(shared.memoryRootId)),
        })).partition.scope,
        "project",
      );
      assert.isTrue(
        (yield* repository.getCurrent({
          access,
          rootId: AkeruMemoryRootId.make(String(sensitive.memoryRootId)),
        })).sensitive,
      );
    }),
  );

  it.effect("rejects a persisted pending update when its expected revision is stale", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const candidates = yield* MemoryCandidateRepository;
      const handlers = createMemoryToolHandlers(repository, candidates, access);
      const saved = (yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "Use npm.",
          scope: "private",
        }),
      )) as { rootId: string };
      const pending = (yield* Effect.promise(() =>
        execute("update_memory", handlers.update_memory, {
          memoryId: saved.rootId,
          expectedRevision: 1,
          fact: "Use Bun.",
          scope: "project",
        }),
      )) as { candidateId: string };
      yield* Effect.promise(() =>
        execute("update_memory", handlers.update_memory, {
          memoryId: saved.rootId,
          expectedRevision: 1,
          fact: "Use pnpm.",
          scope: "private",
        }),
      );

      const failed = yield* Effect.promise(() =>
        decideMemoryCandidate(repository, { ...candidates }, access, {
          candidateId: AkeruMemoryCandidateId.make(pending.candidateId),
          decision: "approve",
        }).then(
          () => false,
          (error) => String(error).includes("stale"),
        ),
      );
      const current = yield* repository.getCurrent({
        access,
        rootId: AkeruMemoryRootId.make(saved.rootId),
      });
      assert.isTrue(failed);
      assert.equal(current.revision, 2);
      assert.equal(current.fact, "Use pnpm.");
    }),
  );

  it.effect("routes forget OCC through tombstone", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const candidates = yield* MemoryCandidateRepository;
      const handlers = createMemoryToolHandlers(repository, candidates, access);
      const saved = (yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "Forget this.",
          scope: "private",
        }),
      )) as { rootId: string };

      const stale = yield* Effect.promise(() =>
        execute("forget_memory", handlers.forget_memory, {
          memoryId: saved.rootId,
          expectedRevision: 2,
        }).then(
          () => false,
          () => true,
        ),
      );
      assert.isTrue(stale);
      const current = yield* repository.getCurrent({
        access,
        rootId: AkeruMemoryRootId.make(saved.rootId),
      });
      assert.equal(current.deletionState, "active");
    }),
  );

  it.effect("propagates candidate creation failures", () =>
    Effect.gen(function* () {
      const repository = yield* EntityMemoryRepository;
      const candidates = yield* MemoryCandidateRepository;
      const currentCount = (yield* repository.listCurrent({ access })).length;
      const handlers = createMemoryToolHandlers(
        repository,
        {
          ...candidates,
          create: () => Effect.die(new Error("candidate write failed")),
        },
        access,
      );

      const failed = yield* Effect.promise(() =>
        execute("remember", handlers.remember, {
          fact: "The project uses Bun.",
          scope: "project",
        }).then(
          () => false,
          (error) => String(error).includes("candidate write failed"),
        ),
      );
      assert.isTrue(failed);
      assert.equal((yield* repository.listCurrent({ access })).length, currentCount);
    }),
  );
});
