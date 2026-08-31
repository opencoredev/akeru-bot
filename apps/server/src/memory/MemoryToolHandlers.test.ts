import { assert, it } from "@effect/vitest";
import {
  AkeruMemoryCandidateId,
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

      const before = yield* repository.getCurrent({
        access,
        rootId: AkeruMemoryRootId.make(saved.rootId),
      });
      assert.equal(before.revision, 1);
      assert.equal(invalidations, 0);
      yield* Effect.promise(() =>
        decideMemoryCandidate(
          repository,
          candidates,
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
