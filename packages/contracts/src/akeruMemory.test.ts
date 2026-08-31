import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AKERU_MEMORY_PACKET_MAX_CHARS,
  AKERU_MEMORY_PACKET_MAX_ESTIMATED_TOKENS,
  AKERU_MEMORY_PACKET_MAX_FACTS,
  AkeruMemoryCandidate,
  AkeruMemoryCandidateDecision,
  AkeruMemoryExportInput,
  AkeruMemoryImportPreviewInput,
  AkeruMemoryDecisionReceipt,
  AkeruMemoryPacket,
  AkeruMemoryMutateInput,
  AkeruMemoryRevision,
} from "./akeruMemory.ts";

const revision = {
  id: "memory-1",
  rootId: "root-1",
  revision: 1,
  partition: { tenantId: "tenant-1", scope: "bot-user", partitionId: "bot-1:user-1" },
  entityKind: "user",
  entityId: "user-1",
  kind: "preference",
  value: { theme: "dark" },
  fact: "The user prefers dark themes.",
  sourceThreadId: "thread-1",
  sourceMessageId: "message-1",
  authorBotId: "bot-1",
  initiatingUserId: "user-1",
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
  affectedBotIds: ["bot-1"],
} as const;

describe("Akeru memory contracts", () => {
  it.effect("decodes a complete immutable memory revision", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(AkeruMemoryRevision)(revision);
      assert.equal(decoded.partition.scope, "bot-user");
      assert.equal(decoded.value.theme, "dark");
    }),
  );

  it.effect("rejects confidence outside the supported range", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(AkeruMemoryRevision)({
        ...revision,
        confidence: 1.01,
      }).pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");
    }),
  );

  it.effect("types pending candidates and editable approval decisions", () =>
    Effect.gen(function* () {
      const candidate = yield* Schema.decodeUnknownEffect(AkeruMemoryCandidate)({
        candidateId: "candidate-1",
        tenantId: "tenant-1",
        initiatingUserId: "user-1",
        sourceThreadId: "thread-1",
        sourceMessageId: "message-1",
        authorBotId: "bot-1",
        fact: "The project uses Bun.",
        scope: "project",
        sensitive: false,
        confidence: 0.9,
        affectedBotIds: ["bot-1", "bot-2"],
        status: "pending",
        createdAt: "2026-08-30T21:00:00.000Z",
        decidedAt: null,
        decidedMemoryRootId: null,
      });
      assert.isNull(candidate.pendingUpdate);
      const decision = yield* Schema.decodeUnknownEffect(AkeruMemoryCandidateDecision)({
        candidateId: candidate.candidateId,
        decision: "approve",
        fact: "The project uses Bun 2.",
        scope: "workspace",
      });

      assert.equal(candidate.status, "pending");
      assert.equal(decision.decision, "approve");
    }),
  );

  it.effect("accepts workspace memory archives", () =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(AkeruMemoryExportInput)({
        threadId: "thread-1",
        complete: true,
        target: "workspace",
      });
      assert.equal(input.target, "workspace");
    }),
  );

  it.effect("rejects version 1 import archives at the RPC boundary", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(AkeruMemoryImportPreviewInput)({
        threadId: "thread-1",
        target: "thread",
        archive: {
          schemaVersion: 1,
          threadId: "thread-1",
          complete: true,
          createdAt: "2026-08-30T21:00:00.000Z",
          files: [],
          manifestSha256: "a".repeat(64),
        },
      }).pipe(Effect.exit);

      assert.isTrue(result._tag === "Failure");
    }),
  );

  it.effect("requires rejected decisions and durable receipts to identify the candidate", () =>
    Effect.gen(function* () {
      const rejected = yield* Schema.decodeUnknownEffect(AkeruMemoryCandidateDecision)({
        candidateId: "candidate-1",
        decision: "reject",
      });
      const receipt = yield* Schema.decodeUnknownEffect(AkeruMemoryDecisionReceipt)({
        candidateId: "candidate-1",
        status: "rejected",
        fact: "Do not save this.",
        scope: "private",
        affectedBotIds: ["bot-1"],
        memoryRootId: null,
        createdAt: "2026-08-30T21:00:00.000Z",
      });

      assert.equal(rejected.decision, "reject");
      assert.isNull(receipt.memoryRootId);
    }),
  );

  it.effect("enforces all provider memory packet bounds", () =>
    Effect.gen(function* () {
      const fact = {
        memoryId: "memory-1",
        expectedRevision: 1,
        scope: "user",
        kind: "fact",
        fact: "A fact",
        pinned: false,
        confidence: 1,
        updatedAt: "2026-08-30T21:00:00.000Z",
      } as const;
      const decode = Schema.decodeUnknownEffect(AkeruMemoryPacket);
      const tooManyFacts = yield* decode({
        threadId: "thread-1",
        facts: Array.from({ length: AKERU_MEMORY_PACKET_MAX_FACTS + 1 }, () => fact),
        estimatedTokens: 1,
        rendered: "memory",
      }).pipe(Effect.exit);
      const tooManyTokens = yield* decode({
        threadId: "thread-1",
        facts: [fact],
        estimatedTokens: AKERU_MEMORY_PACKET_MAX_ESTIMATED_TOKENS + 1,
        rendered: "memory",
      }).pipe(Effect.exit);
      const tooManyChars = yield* decode({
        threadId: "thread-1",
        facts: [fact],
        estimatedTokens: 1,
        rendered: "x".repeat(AKERU_MEMORY_PACKET_MAX_CHARS + 1),
      }).pipe(Effect.exit);

      assert.isTrue(tooManyFacts._tag === "Failure");
      assert.isTrue(tooManyTokens._tag === "Failure");
      assert.isTrue(tooManyChars._tag === "Failure");
    }),
  );

  it.effect("decodes allowlisted memory mutations and rejects extra fields", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(AkeruMemoryMutateInput);
      const edit = yield* decode({
        threadId: "thread-1",
        mutation: {
          operation: "fact.edit",
          memoryId: "root-1",
          expectedRevision: 1,
          fact: "The user prefers concise replies.",
        },
      });
      const arbitrary = yield* decode({
        threadId: "thread-1",
        mutation: { operation: "database.execute", sql: "DELETE FROM memory" },
      }).pipe(Effect.exit);
      const deleteWithoutRevision = yield* decode({
        threadId: "thread-1",
        mutation: { operation: "fact.delete", memoryId: "root-1" },
      }).pipe(Effect.exit);

      assert.equal(edit.mutation.operation, "fact.edit");
      assert.isTrue(arbitrary._tag === "Failure");
      assert.isTrue(deleteWithoutRevision._tag === "Failure");
    }),
  );
});
