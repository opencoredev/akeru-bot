// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AkeruMemoryCandidateId,
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryRootId,
  type AkeruMemoryCandidateDecision,
  type AkeruMemoryDecisionReceipt,
  type AkeruMemoryRevision,
  type AkeruMemoryScope,
  type AkeruMemoryTargetScope,
  type AkeruMemoryThreadAccess,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { AkeruToolExecution } from "../provider/AkeruToolRuntime.ts";
import { deriveAkeruWorkspaceId, resolveAuthorizedMemoryPartitions } from "./EntityMemoryAccess.ts";
import type { EntityMemoryRepositoryShape } from "./Services/EntityMemoryRepository.ts";
import type { MemoryCandidateRepositoryShape } from "./Services/MemoryCandidateRepository.ts";

export type AkeruMemoryToolId = "recall_memory" | "remember" | "update_memory" | "forget_memory";

export type AkeruMemoryToolHandler = (
  input: Omit<AkeruToolExecution, "toolId"> & { readonly toolId: AkeruMemoryToolId },
) => Promise<unknown>;

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

function field(input: unknown, name: string): unknown {
  return typeof input === "object" && input !== null
    ? Object.getOwnPropertyDescriptor(input, name)?.value
    : undefined;
}

function stringField(input: unknown, name: string): string {
  const value = field(input, name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Memory tool field '${name}' is required.`);
  }
  return value;
}

function expectedRevision(input: unknown): number {
  const value = field(input, "expectedRevision");
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("Memory tool field 'expectedRevision' must be a positive integer.");
  }
  return value;
}

function targetScope(input: unknown): AkeruMemoryTargetScope {
  const scope = stringField(input, "scope");
  if (
    scope === "private" ||
    scope === "bot" ||
    scope === "project" ||
    scope === "group" ||
    scope === "workspace"
  ) {
    return scope;
  }
  throw new Error(`Memory scope '${scope}' is not supported.`);
}

const storedScope = (scope: AkeruMemoryTargetScope): AkeruMemoryScope =>
  scope === "private" ? "bot-user" : scope;

function entityFor(scope: AkeruMemoryScope, access: AkeruMemoryThreadAccess) {
  switch (scope) {
    case "bot-user":
    case "user":
      return { entityKind: "user" as const, entityId: AkeruMemoryEntityId.make(access.userId) };
    case "bot":
      if (access.botId === null) throw new Error("This thread has no private bot identity.");
      return { entityKind: "bot" as const, entityId: AkeruMemoryEntityId.make(access.botId) };
    case "project":
      return {
        entityKind: "project" as const,
        entityId: AkeruMemoryEntityId.make(access.projectId),
      };
    case "group":
      if (access.groupId === null) throw new Error("This thread is not in a group.");
      return { entityKind: "group" as const, entityId: AkeruMemoryEntityId.make(access.groupId) };
    case "workspace":
      return {
        entityKind: "workspace" as const,
        entityId: AkeruMemoryEntityId.make(deriveAkeruWorkspaceId(access.workspaceRoot)),
      };
    case "thread":
      return { entityKind: "other" as const, entityId: AkeruMemoryEntityId.make(access.threadId) };
  }
}

async function partitionFor(scope: AkeruMemoryTargetScope, access: AkeruMemoryThreadAccess) {
  const wanted = storedScope(scope);
  const partitions = await Effect.runPromise(resolveAuthorizedMemoryPartitions(access));
  const partition = partitions.find((candidate) => candidate.scope === wanted);
  if (!partition) throw new Error(`Memory scope '${scope}' is not available to this thread.`);
  return partition;
}

const affectedBotIds = (access: AkeruMemoryThreadAccess) =>
  access.groupId !== null
    ? [...access.groupMemberBotIds]
    : access.botId === null
      ? []
      : [access.botId];

async function revisionFor(
  access: AkeruMemoryThreadAccess,
  scope: AkeruMemoryTargetScope,
  fact: string,
  sensitive: boolean,
  now: string,
  current?: AkeruMemoryRevision,
) {
  const partition =
    current?.partition.scope === "user" && scope === "private"
      ? { ...current.partition, visibility: current.visibility }
      : await partitionFor(scope, access);
  return {
    ...current,
    id: AkeruMemoryId.make(NodeCrypto.randomUUID()),
    rootId: current?.rootId ?? AkeruMemoryRootId.make(NodeCrypto.randomUUID()),
    revision: current === undefined ? 1 : current.revision + 1,
    partition,
    ...entityFor(partition.scope, access),
    kind: current?.kind ?? "fact",
    value: current?.value ?? {},
    fact,
    sourceThreadId: current?.sourceThreadId ?? access.threadId,
    sourceMessageId: current?.sourceMessageId ?? null,
    authorBotId: current?.authorBotId ?? access.respondingBotId ?? access.botId,
    initiatingUserId: current?.initiatingUserId ?? access.userId,
    createdAt: current?.createdAt ?? now,
    confirmedAt: now,
    updatedAt: now,
    confidence: current?.confidence ?? 1,
    approvalState: "approved" as const,
    supersedesId: current?.id ?? null,
    supersededById: null,
    visibility: partition.visibility,
    deletionState: "active" as const,
    pinned: current?.pinned ?? false,
    sensitive,
    affectedBotIds: affectedBotIds(access),
  } satisfies AkeruMemoryRevision;
}

export async function decideMemoryCandidate(
  repository: EntityMemoryRepositoryShape,
  candidates: MemoryCandidateRepositoryShape,
  access: AkeruMemoryThreadAccess,
  decision: AkeruMemoryCandidateDecision,
  invalidateDerivedMemory?: (input: {
    readonly rootId: AkeruMemoryRootId;
    readonly affectedBotIds: ReadonlyArray<string>;
  }) => void | Promise<void>,
): Promise<AkeruMemoryDecisionReceipt> {
  const candidate = (await Effect.runPromise(candidates.listPending({ access }))).find(
    (item) => item.candidateId === decision.candidateId,
  );
  if (!candidate) throw new Error("The memory candidate is missing or already decided.");
  const decidedAt = nowIso();
  if (decision.decision === "reject") {
    const receipt = await Effect.runPromise(
      candidates.reject({
        access,
        candidateId: candidate.candidateId,
        receiptId: `memory-${NodeCrypto.randomUUID()}`,
        decidedAt,
      }),
    );
    return receipt;
  }

  const current =
    candidate.pendingUpdate === null
      ? undefined
      : await Effect.runPromise(
          repository.getCurrent({ access, rootId: candidate.pendingUpdate.rootId }),
        );
  if (current !== undefined && current.revision !== candidate.pendingUpdate?.expectedRevision) {
    throw new Error(`Memory revision ${candidate.pendingUpdate?.expectedRevision} is stale.`);
  }
  const revision = await revisionFor(
    access,
    decision.scope ?? candidate.scope,
    decision.fact ?? candidate.fact,
    candidate.sensitive,
    decidedAt,
    current,
  );
  const receipt = await Effect.runPromise(
    candidates.approve({
      access,
      candidateId: candidate.candidateId,
      revision,
      receiptId: `memory-${NodeCrypto.randomUUID()}`,
      decidedAt,
    }),
  );
  if (current !== undefined) {
    await invalidateDerivedMemory?.({
      rootId: revision.rootId,
      affectedBotIds: revision.affectedBotIds,
    });
  }
  return receipt;
}

export function createMemoryToolHandlers(
  repository: EntityMemoryRepositoryShape,
  candidates: MemoryCandidateRepositoryShape,
  access: AkeruMemoryThreadAccess,
  invalidateDerivedMemory?: (input: {
    readonly rootId: AkeruMemoryRootId;
    readonly affectedBotIds: ReadonlyArray<string>;
  }) => void | Promise<void>,
): Record<AkeruMemoryToolId, AkeruMemoryToolHandler> {
  const createCandidate = async (
    fact: string,
    scope: AkeruMemoryTargetScope,
    sensitive: boolean,
    now: string,
    update?: { readonly rootId: AkeruMemoryRootId; readonly expectedRevision: number },
  ) => {
    const candidateId = AkeruMemoryCandidateId.make(NodeCrypto.randomUUID());
    return Effect.runPromise(
      candidates.create({
        access,
        candidate: {
          candidateId,
          tenantId: access.tenantId,
          initiatingUserId: access.userId,
          sourceThreadId: access.threadId,
          sourceMessageId: null,
          authorBotId: access.respondingBotId ?? access.botId,
          fact,
          scope,
          sensitive,
          confidence: 1,
          affectedBotIds: affectedBotIds(access),
          pendingUpdate: update ?? null,
          status: "pending",
          createdAt: now,
          decidedAt: null,
          decidedMemoryRootId: null,
        },
      }),
    );
  };

  return {
    recall_memory: async ({ input }) => {
      const rows = await Effect.runPromise(
        repository.search({
          access,
          query: stringField(input, "query"),
          limit: typeof field(input, "limit") === "number" ? Number(field(input, "limit")) : 10,
        }),
      );
      const includeSensitive = field(input, "includeSensitive") === true;
      return rows
        .filter((revision) => includeSensitive || !revision.sensitive)
        .map((revision) => ({
          memoryId: revision.rootId,
          expectedRevision: revision.revision,
          scope: revision.partition.scope,
          kind: revision.kind,
          fact: revision.fact,
          sensitive: revision.sensitive,
          updatedAt: revision.updatedAt,
        }));
    },
    remember: async ({ input }) => {
      const scope = targetScope(input);
      const sensitive = field(input, "sensitive") === true;
      const fact = stringField(input, "fact");
      const now = nowIso();
      if (scope !== "private" || sensitive) return createCandidate(fact, scope, sensitive, now);
      return Effect.runPromise(
        repository.insert({
          access,
          revision: await revisionFor(access, scope, fact, false, now),
        }),
      );
    },
    update_memory: async ({ input }) => {
      const rootId = AkeruMemoryRootId.make(stringField(input, "memoryId"));
      const expected = expectedRevision(input);
      const current = await Effect.runPromise(repository.getCurrent({ access, rootId }));
      const scope = targetScope(input);
      const sensitive =
        typeof field(input, "sensitive") === "boolean"
          ? field(input, "sensitive") === true
          : current.sensitive;
      const fact = stringField(input, "fact");
      const now = nowIso();
      if (
        current.partition.scope !== "bot-user" ||
        current.sensitive ||
        scope !== "private" ||
        sensitive
      ) {
        return createCandidate(fact, scope, sensitive, now, {
          rootId,
          expectedRevision: expected,
        });
      }
      const revision = await revisionFor(access, scope, fact, false, now, current);
      const saved = await Effect.runPromise(
        repository.revise({
          access,
          expectedRevision: expected,
          revision,
        }),
      );
      await invalidateDerivedMemory?.({ rootId, affectedBotIds: saved.affectedBotIds });
      return saved;
    },
    forget_memory: async ({ input }) => {
      const rootId = AkeruMemoryRootId.make(stringField(input, "memoryId"));
      const tombstone = await Effect.runPromise(
        repository.tombstone({
          access,
          rootId,
          expectedRevision: expectedRevision(input),
          memoryId: AkeruMemoryId.make(NodeCrypto.randomUUID()),
          updatedAt: nowIso(),
        }),
      );
      await invalidateDerivedMemory?.({ rootId, affectedBotIds: tombstone.affectedBotIds });
      return tombstone;
    },
  };
}
