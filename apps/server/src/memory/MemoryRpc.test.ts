import {
  AkeruMemoryOperationError,
  AkeruMemoryCandidateId,
  AkeruMemoryId,
  AkeruMemoryRootId,
  AkeruMemoryEntityId,
  AkeruMemoryPartitionId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  ProjectId,
  ThreadId,
  type AkeruMemoryRevision,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createMemoryRpcHandlers } from "./MemoryRpc.ts";
import {
  EntityMemoryConflictError,
  type EntityMemoryRepositoryShape,
  type TombstoneEntityMemoryInput,
} from "./Services/EntityMemoryRepository.ts";
import {
  MemoryCandidateConflictError,
  type MemoryCandidateRepositoryShape,
} from "./Services/MemoryCandidateRepository.ts";

const access = {
  tenantId: AkeruMemoryTenantId.make("local"),
  userId: AkeruMemoryUserId.make("owner"),
  threadId: ThreadId.make("authorized-thread"),
  projectId: ProjectId.make("project"),
  workspaceRoot: "/tmp/project",
  botId: BotId.make("bot"),
  groupId: null,
  respondingBotId: BotId.make("bot"),
  groupMemberBotIds: [],
};

const revision = {
  id: AkeruMemoryId.make("revision-3"),
  rootId: AkeruMemoryRootId.make("root-1"),
  revision: 3,
  partition: {
    tenantId: access.tenantId,
    scope: "thread",
    partitionId: AkeruMemoryPartitionId.make("authorized-thread"),
  },
  entityKind: "other",
  entityId: AkeruMemoryEntityId.make("authorized-thread"),
  kind: "fact",
  value: {},
  fact: "A fact",
  sourceThreadId: ThreadId.make("source-thread"),
  sourceMessageId: null,
  authorBotId: BotId.make("bot"),
  initiatingUserId: AkeruMemoryUserId.make("owner"),
  createdAt: "2026-08-31T20:00:00.000Z",
  confirmedAt: "2026-08-31T20:00:00.000Z",
  updatedAt: "2026-08-31T20:00:00.000Z",
  confidence: 1,
  approvalState: "approved",
  supersedesId: null,
  supersededById: null,
  visibility: "private",
  deletionState: "active",
  pinned: false,
  sensitive: false,
  affectedBotIds: [BotId.make("bot")],
} satisfies AkeruMemoryRevision;

const candidates = {
  create: () => Effect.die("not used"),
  listPending: () => Effect.succeed([]),
  approve: () => Effect.die("not used"),
  reject: () => Effect.die("not used"),
} satisfies MemoryCandidateRepositoryShape;

describe("memory RPC handlers", () => {
  it.effect("exports conversation memory only from the authorized thread", () =>
    Effect.gen(function* () {
      const readThreads: ThreadId[] = [];
      const repository = {
        listByPartitions: () => Effect.succeed([revision]),
      } as unknown as EntityMemoryRepositoryShape;
      const handlers = createMemoryRpcHandlers({
        repository,
        candidates,
        readConversation: (threadId) =>
          Effect.sync(() => {
            readThreads.push(threadId);
            return { current: null, history: [] };
          }),
        clearConversation: () => Effect.void,
      });

      const archive = yield* handlers.exportArchive({
        access,
        target: "thread",
        complete: true,
        createdAt: "2026-08-31T21:00:00.000Z",
      });

      assert.deepEqual(readThreads, [access.threadId]);
      assert.equal(archive.anchorThreadId, access.threadId);
      assert.equal(archive.conversations[0]?.threadId, access.threadId);
    }),
  );

  it.effect(
    "passes delete revisions to tombstone and returns stale OCC as an operation error",
    () =>
      Effect.gen(function* () {
        const seen: number[] = [];
        const repository = {
          tombstone: (input: TombstoneEntityMemoryInput) =>
            Effect.sync(() => seen.push(input.expectedRevision)).pipe(
              Effect.andThen(
                Effect.fail(
                  new EntityMemoryConflictError({
                    rootId: input.rootId,
                    expectedRevision: input.expectedRevision,
                    actualRevision: 4,
                  }),
                ),
              ),
            ),
        } as unknown as EntityMemoryRepositoryShape;
        const handlers = createMemoryRpcHandlers({
          repository,
          candidates,
          readConversation: () => Effect.succeed({ current: null, history: [] }),
          clearConversation: () => Effect.void,
        });

        const failure = yield* handlers
          .mutate(access, {
            operation: "fact.delete",
            memoryId: revision.rootId,
            expectedRevision: 3,
          })
          .pipe(Effect.flip);

        assert.deepEqual(seen, [3]);
        assert.instanceOf(failure, AkeruMemoryOperationError);
        assert.include(failure.detail, "Expected 3, found 4");
      }),
  );

  it.effect("returns candidate repository failures as operation errors", () =>
    Effect.gen(function* () {
      const candidateId = AkeruMemoryCandidateId.make("candidate-1");
      const failure = new MemoryCandidateConflictError({
        candidateId,
        detail: "The candidate batch failed.",
      });
      const handlers = createMemoryRpcHandlers({
        repository: {} as EntityMemoryRepositoryShape,
        candidates: {
          ...candidates,
          listPending: () => Effect.fail(failure),
        },
        readConversation: () => Effect.succeed({ current: null, history: [] }),
        clearConversation: () => Effect.void,
      });

      const result = yield* handlers
        .mutate(access, {
          operation: "candidate.decide",
          decision: { candidateId, decision: "reject" },
        })
        .pipe(Effect.flip);

      assert.instanceOf(result, AkeruMemoryOperationError);
      assert.include(result.detail, "candidate batch failed");
    }),
  );
});
