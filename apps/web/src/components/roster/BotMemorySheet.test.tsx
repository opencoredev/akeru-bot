// @effect-diagnostics nodeBuiltinImport:off - The component contract reads its source.
import * as NodeFS from "node:fs";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AkeruMemoryArchiveV2,
  AkeruMemoryCandidate,
  AkeruMemoryRevision,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  candidateDecisionInput,
  factDeleteInput,
  factEditInput,
  importApplyInput,
  importStateForThread,
  memoryErrorMessage,
} from "./BotMemorySheet";
import { resolveBotThreadTarget } from "./useBotThreadRef";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const decodeArchive = Schema.decodeUnknownSync(AkeruMemoryArchiveV2);
const revision = Schema.decodeUnknownSync(AkeruMemoryRevision)({
  id: "memory-3",
  rootId: "root-1",
  revision: 3,
  partition: { tenantId: "tenant-1", scope: "bot", partitionId: "bot-1" },
  entityKind: "bot",
  entityId: "bot-1",
  kind: "fact",
  value: {},
  fact: "The user prefers short answers.",
  sourceThreadId: "thread-1",
  sourceMessageId: null,
  authorBotId: "bot-1",
  initiatingUserId: "user-1",
  createdAt: "2026-08-31T00:00:00.000Z",
  confirmedAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  confidence: 0.9,
  approvalState: "approved",
  supersedesId: "memory-2",
  supersededById: null,
  visibility: "private",
  deletionState: "active",
  pinned: false,
  sensitive: false,
  affectedBotIds: ["bot-1"],
});
const candidate = Schema.decodeUnknownSync(AkeruMemoryCandidate)({
  candidateId: "candidate-1",
  tenantId: "tenant-1",
  initiatingUserId: "user-1",
  sourceThreadId: "thread-1",
  sourceMessageId: null,
  authorBotId: "bot-1",
  fact: "The user works in New York.",
  scope: "private",
  sensitive: false,
  confidence: 0.8,
  affectedBotIds: ["bot-1"],
  pendingUpdate: null,
  status: "pending",
  createdAt: "2026-08-31T00:00:00.000Z",
  decidedAt: null,
  decidedMemoryRootId: null,
});

describe("BotMemorySheet", () => {
  it("renders facts, revision history, pending decisions, transfer controls, and failures", () => {
    const source = NodeFS.readFileSync(new URL("./BotMemorySheet.tsx", import.meta.url), "utf8");
    expect(source).toContain('data-testid="memory-fact"');
    expect(source).toContain("revisions");
    expect(source).toContain('data-testid="pending-memory"');
    expect(source).toContain('data-testid="memory-import-preview"');
    expect(source).toContain('role="alert"');
    expect(source).toContain("Preview import");
    expect(source).toContain("Apply import");
  });

  it("uses the displayed revision for edits and exposes a stale-conflict retry boundary", () => {
    const input = factEditInput(threadRef, revision, "  Updated fact  ");
    expect(input.input).toMatchObject({
      threadId: "thread-1",
      mutation: {
        operation: "fact.edit",
        memoryId: "root-1",
        expectedRevision: 3,
        fact: "Updated fact",
      },
    });
    expect(
      factEditInput(threadRef, { ...revision, revision: 4 }, "Updated fact").input.mutation
        .expectedRevision,
    ).toBe(4);
  });

  it("sends optimistic concurrency data when deleting", () => {
    expect(factDeleteInput(threadRef, revision).input.mutation).toEqual({
      operation: "fact.delete",
      memoryId: "root-1",
      expectedRevision: 3,
    });
  });

  it("builds explicit approve and reject decisions", () => {
    expect(
      candidateDecisionInput(threadRef, candidate, "approve", "Approved fact", "bot").input.mutation
        .decision,
    ).toEqual({
      candidateId: "candidate-1",
      decision: "approve",
      fact: "Approved fact",
      scope: "bot",
    });
    expect(candidateDecisionInput(threadRef, candidate, "reject").input.mutation.decision).toEqual({
      candidateId: "candidate-1",
      decision: "reject",
    });
  });

  it("applies the exact thread preview", () => {
    const archive = decodeArchive({
      schemaVersion: 2,
      anchorThreadId: "thread-1",
      target: "thread",
      complete: true,
      createdAt: "2026-08-31T00:00:00.000Z",
      files: [],
      revisions: [],
      conversations: [],
      manifestSha256: "a".repeat(64),
    });
    const state = {
      threadRef,
      archive,
      preview: { previewHash: "b".repeat(64), items: [] },
    };
    const input = importApplyInput(state);
    expect(input.input).toMatchObject({
      threadId: "thread-1",
      target: "thread",
      previewHash: "b".repeat(64),
    });
    expect(
      importStateForThread(
        state,
        scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-2")),
      ),
    ).toBeNull();
  });

  it("keeps server failures and falls back for unknown errors", () => {
    expect(memoryErrorMessage(new Error("Revision conflict."))).toBe("Revision conflict.");
    expect(memoryErrorMessage(null)).toBe("Memory request failed.");
  });

  it("wires the authorized bot thread into the panel", () => {
    const route = NodeFS.readFileSync(
      new URL("../../routes/_chat.bots.$botId.tsx", import.meta.url),
      "utf8",
    );
    expect(route).toContain("useBotThreadRef(botId)");
    expect(route).toContain("threadRef={threadRef}");
  });

  it("keeps memory bound to the selected bot conversation", () => {
    expect(
      resolveBotThreadTarget(
        "bot-1",
        "env-1",
        [
          {
            environmentId: "env-1",
            id: "thread-selected",
            botId: "bot-1",
            updatedAt: "2026-08-30T00:00:00.000Z",
            archivedAt: null,
            deletedAt: null,
          },
          {
            environmentId: "env-1",
            id: "thread-newer",
            botId: "bot-1",
            updatedAt: "2026-08-31T00:00:00.000Z",
            archivedAt: null,
            deletedAt: null,
          },
        ],
        "/env-1/thread-selected",
      ),
    ).toMatchObject({ threadId: "thread-selected" });
  });
});
