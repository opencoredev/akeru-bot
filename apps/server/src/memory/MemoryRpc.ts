// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryOperationError,
  AkeruMemoryRootId,
  type AkeruConversationMemorySnapshot,
  type AkeruMemoryArchiveTarget,
  type AkeruMemoryArchiveV2,
  type AkeruMemoryCandidateDecision,
  type AkeruMemoryMutation,
  type AkeruMemoryMutationResult,
  type AkeruMemoryRevision,
  type AkeruMemoryTargetScope,
  type AkeruMemoryThreadAccess,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { deriveAkeruWorkspaceId, resolveAuthorizedMemoryPartitions } from "./EntityMemoryAccess.ts";
import { exportAkeruMemory } from "./MemoryExport.ts";
import { applyAkeruMemoryImport, previewAkeruMemoryImport } from "./MemoryImport.ts";
import type { EntityMemoryRepositoryShape } from "./Services/EntityMemoryRepository.ts";
import type { MemoryCandidateRepositoryShape } from "./Services/MemoryCandidateRepository.ts";

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());
const affectedBotIds = (access: AkeruMemoryThreadAccess) =>
  access.groupId === null
    ? access.botId === null
      ? []
      : [access.botId]
    : [...access.groupMemberBotIds];

const entityFor = (
  scope: AkeruMemoryRevision["partition"]["scope"],
  access: AkeruMemoryThreadAccess,
) => {
  switch (scope) {
    case "user":
    case "bot-user":
      return { entityKind: "user" as const, entityId: AkeruMemoryEntityId.make(access.userId) };
    case "bot":
      if (access.botId === null) throw new Error("This chat has no private bot identity.");
      return { entityKind: "bot" as const, entityId: AkeruMemoryEntityId.make(access.botId) };
    case "project":
      return {
        entityKind: "project" as const,
        entityId: AkeruMemoryEntityId.make(access.projectId),
      };
    case "group":
      if (access.groupId === null) throw new Error("This chat is not in a group.");
      return { entityKind: "group" as const, entityId: AkeruMemoryEntityId.make(access.groupId) };
    case "workspace":
      return {
        entityKind: "workspace" as const,
        entityId: AkeruMemoryEntityId.make(deriveAkeruWorkspaceId(access.projectId)),
      };
    case "thread":
      return { entityKind: "other" as const, entityId: AkeruMemoryEntityId.make(access.threadId) };
  }
};

const partitionFor = (scope: AkeruMemoryTargetScope, access: AkeruMemoryThreadAccess) =>
  resolveAuthorizedMemoryPartitions(access).pipe(
    Effect.flatMap((partitions) => {
      const storedScope = scope === "private" ? "bot-user" : scope;
      const partition = partitions.find((candidate) => candidate.scope === storedScope);
      return partition
        ? Effect.succeed(partition)
        : Effect.fail(
            new AkeruMemoryOperationError({
              operation: "mutate",
              detail: `Memory scope '${scope}' is not available to this thread.`,
            }),
          );
    }),
  );

const decideCandidate = Effect.fn("MemoryRpc.decideCandidate")(function* (input: {
  readonly candidates: MemoryCandidateRepositoryShape;
  readonly access: AkeruMemoryThreadAccess;
  readonly decision: AkeruMemoryCandidateDecision;
}) {
  const candidate = (yield* input.candidates.listPending({ access: input.access })).find(
    (item) => item.candidateId === input.decision.candidateId,
  );
  if (!candidate) {
    return yield* new AkeruMemoryOperationError({
      operation: "mutate",
      detail: "The memory candidate is missing or already decided.",
    });
  }
  const decidedAt = nowIso();
  if (input.decision.decision === "reject") {
    return yield* input.candidates.reject({
      access: input.access,
      candidateId: candidate.candidateId,
      receiptId: `memory-${NodeCrypto.randomUUID()}`,
      decidedAt,
    });
  }
  const partition = yield* partitionFor(input.decision.scope ?? candidate.scope, input.access);
  const revision: AkeruMemoryRevision = {
    id: AkeruMemoryId.make(NodeCrypto.randomUUID()),
    rootId: AkeruMemoryRootId.make(NodeCrypto.randomUUID()),
    revision: 1,
    partition,
    ...entityFor(partition.scope, input.access),
    kind: "fact",
    value: {},
    fact: input.decision.fact ?? candidate.fact,
    sourceThreadId: candidate.sourceThreadId,
    sourceMessageId: candidate.sourceMessageId,
    authorBotId: candidate.authorBotId,
    initiatingUserId: candidate.initiatingUserId,
    createdAt: candidate.createdAt,
    confirmedAt: decidedAt,
    updatedAt: decidedAt,
    confidence: candidate.confidence,
    approvalState: "approved",
    supersedesId: null,
    supersededById: null,
    visibility: partition.visibility,
    deletionState: "active",
    pinned: false,
    sensitive: candidate.sensitive,
    affectedBotIds: affectedBotIds(input.access),
  };
  return yield* input.candidates.approve({
    access: input.access,
    candidateId: candidate.candidateId,
    revision,
    receiptId: `memory-${NodeCrypto.randomUUID()}`,
    decidedAt,
  });
});

export interface MemoryRpcBackend {
  readonly repository: EntityMemoryRepositoryShape;
  readonly candidates: MemoryCandidateRepositoryShape;
  readonly readConversation: (
    threadId: AkeruMemoryThreadAccess["threadId"],
  ) => Effect.Effect<AkeruConversationMemorySnapshot, AkeruMemoryOperationError>;
  readonly clearConversation: (
    threadId: AkeruMemoryThreadAccess["threadId"],
  ) => Effect.Effect<void, AkeruMemoryOperationError>;
}

export const memoryOperationError = (operation: string, cause: unknown) =>
  new AkeruMemoryOperationError({
    operation,
    detail:
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "The memory operation failed.",
  });

export function createMemoryRpcHandlers(backend: MemoryRpcBackend) {
  const inspect = (access: AkeruMemoryThreadAccess) =>
    Effect.gen(function* () {
      const { durable, pending, conversation } = yield* Effect.all({
        durable: backend.repository.listCurrent({ access }),
        pending: backend.candidates.listPending({ access }),
        conversation: backend.readConversation(access.threadId),
      });
      const histories = yield* Effect.forEach(
        durable,
        (revision) =>
          backend.repository
            .listHistory({ access, rootId: revision.rootId })
            .pipe(Effect.map((revisions) => ({ rootId: revision.rootId, revisions }))),
        { concurrency: 4 },
      );
      return { threadId: access.threadId, durable, histories, pending, conversation };
    });

  const mutate = (access: AkeruMemoryThreadAccess, mutation: AkeruMemoryMutation) =>
    Effect.gen(function* () {
      if (mutation.operation === "candidate.decide") {
        const receipt = yield* decideCandidate({
          candidates: backend.candidates,
          access,
          decision: mutation.decision,
        });
        return { kind: "candidate", receipt } satisfies AkeruMemoryMutationResult;
      }
      if (mutation.operation === "conversation.clear") {
        yield* backend.clearConversation(access.threadId);
        return { kind: "conversation-cleared" } satisfies AkeruMemoryMutationResult;
      }
      if (mutation.operation === "fact.forget" || mutation.operation === "fact.delete") {
        const revision = yield* backend.repository.tombstone({
          access,
          rootId: mutation.memoryId,
          expectedRevision: mutation.expectedRevision,
          memoryId: AkeruMemoryId.make(NodeCrypto.randomUUID()),
          updatedAt: nowIso(),
        });
        return mutation.operation === "fact.delete"
          ? ({ kind: "deleted", memoryId: mutation.memoryId } satisfies AkeruMemoryMutationResult)
          : ({ kind: "revision", revision } satisfies AkeruMemoryMutationResult);
      }
      const current = yield* backend.repository.getCurrent({ access, rootId: mutation.memoryId });
      const updatedAt = nowIso();
      const base = {
        ...current,
        id: AkeruMemoryId.make(NodeCrypto.randomUUID()),
        revision: mutation.expectedRevision + 1,
        updatedAt,
        confirmedAt: updatedAt,
        supersedesId: current.id,
        supersededById: null,
      } satisfies AkeruMemoryRevision;
      const revision =
        mutation.operation === "fact.edit"
          ? { ...base, fact: mutation.fact }
          : mutation.operation === "fact.pin"
            ? { ...base, pinned: mutation.pinned }
            : yield* partitionFor(mutation.scope, access).pipe(
                Effect.map((partition) => ({
                  ...base,
                  partition,
                  ...entityFor(partition.scope, access),
                  visibility: partition.visibility,
                  affectedBotIds: affectedBotIds(access),
                })),
              );
      const saved = yield* backend.repository.revise({
        access,
        expectedRevision: mutation.expectedRevision,
        revision,
      });
      return { kind: "revision", revision: saved } satisfies AkeruMemoryMutationResult;
    });

  return {
    inspect: (access: AkeruMemoryThreadAccess) =>
      inspect(access).pipe(Effect.mapError((cause) => memoryOperationError("inspect", cause))),
    mutate: (access: AkeruMemoryThreadAccess, mutation: AkeruMemoryMutation) =>
      mutate(access, mutation).pipe(
        Effect.mapError((cause) => memoryOperationError("mutate", cause)),
      ),
    exportArchive: (input: {
      readonly access: AkeruMemoryThreadAccess;
      readonly target: AkeruMemoryArchiveTarget;
      readonly complete: boolean;
      readonly createdAt: string;
    }) =>
      backend.readConversation(input.access.threadId).pipe(
        Effect.flatMap((snapshot) =>
          exportAkeruMemory({
            repository: backend.repository,
            ...input,
            conversations: [{ threadId: input.access.threadId, snapshot }],
          }),
        ),
        Effect.mapError((cause) => memoryOperationError("export", cause)),
      ),
    previewImport: (input: {
      readonly access: AkeruMemoryThreadAccess;
      readonly target: AkeruMemoryArchiveTarget;
      readonly archive: AkeruMemoryArchiveV2;
    }) =>
      previewAkeruMemoryImport({ repository: backend.repository, ...input }).pipe(
        Effect.mapError((cause) => memoryOperationError("importPreview", cause)),
      ),
    applyImport: (input: {
      readonly access: AkeruMemoryThreadAccess;
      readonly target: AkeruMemoryArchiveTarget;
      readonly archive: AkeruMemoryArchiveV2;
      readonly previewHash: string;
    }) =>
      applyAkeruMemoryImport({ repository: backend.repository, ...input }).pipe(
        Effect.mapError((cause) => memoryOperationError("importApply", cause)),
      ),
  };
}
