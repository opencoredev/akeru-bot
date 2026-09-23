import {
  AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY,
  AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY,
  AkeruMemoryCandidateId,
  BotId,
  ThreadId,
  type AkeruMemoryArchiveV2,
  type AkeruMemoryImportPreview,
  type AkeruMemoryRevision,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSaveDurableFactEdit,
  DURABLE_FACT_CONFLICT_MESSAGE,
  DURABLE_MEMORY_EXPORT_SCOPES,
  DURABLE_MEMORY_INSPECT_SCOPES,
  type DurableMemoryFact,
  describeDurableFactFailure,
  durableFactActions,
  durableFactMoveScopes,
  durableFactReadOnlyReason,
  durableFactSourceLabel,
  durableFactBotsLabel,
  durableFactMutation,
  groupImportPreview,
  memoryApprovalHeading,
  memoryApprovalMutation,
  memoryArchiveSchemaVersion,
  pendingMemoryApprovals,
  resolveImportConflicts,
  summarizeDurableFacts,
} from "./durableMemory.ts";
import { createTranslator } from "./i18n/index.ts";
import { zhCNCatalog } from "./i18n/zh-CN.ts";

const revision = (
  overrides: Partial<AkeruMemoryRevision> & Pick<AkeruMemoryRevision, "id" | "rootId" | "revision">,
) =>
  ({
    partition: { tenantId: "local", scope: "bot-user", partitionId: "bot-1:owner" },
    entityKind: "user",
    entityId: "owner",
    kind: "preference",
    value: {},
    fact: "Prefers short replies.",
    sourceThreadId: "thread-1",
    sourceMessageId: null,
    authorBotId: "bot-1",
    initiatingUserId: "owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    confirmedAt: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    confidence: 0.9,
    approvalState: "approved",
    supersedesId: null,
    supersededById: null,
    visibility: "private",
    deletionState: "active",
    pinned: false,
    sensitive: false,
    affectedBotIds: ["bot-1"],
    ...overrides,
  }) as AkeruMemoryRevision;

const preview = (items: AkeruMemoryImportPreview["items"]) =>
  ({ previewHash: "a".repeat(64), items }) as AkeruMemoryImportPreview;

describe("summarizeDurableFacts", () => {
  it("keeps the newest revision per root with its superseded value and first creation time", () => {
    const facts = summarizeDurableFacts([
      revision({ id: "m1-r1" as never, rootId: "m1" as never, revision: 1 }),
      revision({
        id: "m1-r2" as never,
        rootId: "m1" as never,
        revision: 2,
        fact: "Prefers detailed replies.",
        supersedesId: "m1-r1" as never,
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        pinned: true,
      }),
      revision({
        id: "m2-r1" as never,
        rootId: "m2" as never,
        revision: 1,
        fact: "Works in UTC.",
        approvalState: "pending",
        updatedAt: "2026-09-02T00:00:00.000Z",
      }),
    ]);

    expect(facts.map((fact) => fact.rootId)).toEqual(["m1", "m2"]);
    expect(facts[0]).toMatchObject({
      fact: "Prefers detailed replies.",
      supersededFact: "Prefers short replies.",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      scope: "bot-user",
      pinned: true,
      revision: 2,
    });
    expect(facts[1]).toMatchObject({ approvalState: "pending", supersededFact: null });
  });
});

describe("scope selection", () => {
  it("offers thread, bot, project, and all for export, and omits all for inspection", () => {
    expect(DURABLE_MEMORY_EXPORT_SCOPES.map((option) => option.scope)).toEqual([
      "thread",
      "bot",
      "project",
      "all",
    ]);
    expect(DURABLE_MEMORY_INSPECT_SCOPES.map((option) => option.scope)).toEqual([
      "thread",
      "bot",
      "project",
    ]);
  });

  it("tells durable and bot-note archives apart", () => {
    expect(memoryArchiveSchemaVersion({ schemaVersion: 2 })).toBe(2);
    expect(memoryArchiveSchemaVersion({ schemaVersion: 3 })).toBe(3);
    expect(memoryArchiveSchemaVersion(null)).toBeNull();
    expect(memoryArchiveSchemaVersion({ schemaVersion: "2" })).toBeNull();
  });
});

describe("import conflict choices", () => {
  const items = preview([
    { rootId: "m1" as never, classification: "conflicting", reason: "Histories diverge." },
    { rootId: "m2" as never, classification: "new", reason: "Missing locally." },
    { rootId: "m3" as never, classification: "conflicting", reason: "Histories diverge." },
    { rootId: "m4" as never, classification: "skipped", reason: "Identical." },
  ]);

  it("blocks apply until every conflict has an explicit choice", () => {
    expect(resolveImportConflicts(items, {})).toEqual({ ready: false, unresolved: ["m1", "m3"] });
    expect(resolveImportConflicts(items, { m1: "use-archive" })).toEqual({
      ready: false,
      unresolved: ["m3"],
    });
    expect(resolveImportConflicts(items, { m1: "use-archive", m3: "keep-local" })).toEqual({
      ready: true,
      resolutions: [
        { rootId: "m1", decision: "use-archive" },
        { rootId: "m3", decision: "keep-local" },
      ],
    });
  });

  it("sends no resolutions when nothing conflicts", () => {
    expect(resolveImportConflicts(preview([items.items[1]!]), {})).toEqual({
      ready: true,
      resolutions: [],
    });
  });

  it("groups preview items conflicts first with archive and local text", () => {
    const archive = {
      revisions: [
        {
          revision: revision({
            id: "a1" as never,
            rootId: "m1" as never,
            revision: 1,
            fact: "Archive",
          }),
        },
      ],
    } as unknown as AkeruMemoryArchiveV2;
    const groups = groupImportPreview({
      preview: items,
      archive,
      localFacts: summarizeDurableFacts([
        revision({ id: "l1" as never, rootId: "m1" as never, revision: 1, fact: "Local" }),
      ]),
    });
    expect(groups.map((group) => group.classification)).toEqual(["conflicting", "new", "skipped"]);
    expect(groups[0]!.items[0]).toMatchObject({ archiveFact: "Archive", localFact: "Local" });
    expect(groups[0]!.items[1]).toMatchObject({ archiveFact: null, localFact: null });
  });
});

const fact = (overrides: Partial<DurableMemoryFact> = {}) =>
  ({
    rootId: "root-1",
    fact: "Prefers short replies.",
    scope: "bot-user",
    sourceThreadId: "thread-1",
    affectedBotIds: ["bot-1"],
    approvalState: "approved",
    deletionState: "active",
    pinned: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    revision: 3,
    supersededFact: null,
    ...overrides,
  }) as DurableMemoryFact;

const OPEN = { canOperate: true, memoryEnabled: true, privateBotMemory: true };

describe("durable fact actions", () => {
  it("offers approval only while a fact waits or was rejected, and pin as a toggle", () => {
    expect(durableFactActions(fact(), OPEN)).toEqual(["edit", "pin", "move", "forget", "delete"]);
    expect(durableFactActions(fact({ approvalState: "pending", pinned: true }), OPEN)).toEqual([
      "edit",
      "unpin",
      "move",
      "approve",
      "reject",
      "forget",
      "delete",
    ]);
    expect(durableFactActions(fact({ approvalState: "rejected" }), OPEN)).toContain("approve");
    expect(durableFactActions(fact({ approvalState: "rejected" }), OPEN)).not.toContain("reject");
  });

  it("leaves forgotten facts deletable and read-only connections with nothing", () => {
    expect(durableFactActions(fact({ deletionState: "tombstoned" }), OPEN)).toEqual(["delete"]);
    expect(durableFactActions(fact(), { ...OPEN, canOperate: false })).toEqual([]);
  });

  it("offers nothing while Memory is off and explains why", () => {
    const off = { ...OPEN, memoryEnabled: false };
    expect(durableFactActions(fact(), off)).toEqual([]);
    expect(durableFactActions(fact({ deletionState: "tombstoned" }), off)).toEqual([]);
    expect(durableFactReadOnlyReason(off)).toBe(
      "Memory is off. Turn it on in settings to change facts.",
    );
    expect(durableFactReadOnlyReason({ ...OPEN, canOperate: false })).toBe(
      "This connection can read memory but not change it.",
    );
    expect(durableFactReadOnlyReason(OPEN)).toBeNull();
  });

  it("drops bot-private move targets while private bot memory is off", () => {
    const shared = { ...OPEN, privateBotMemory: false };
    expect(durableFactMoveScopes(fact(), shared).map((option) => option.scope)).toEqual([
      "project",
    ]);
    const projectFact = fact({ scope: "project" });
    expect(durableFactMoveScopes(projectFact, shared)).toEqual([]);
    expect(durableFactActions(projectFact, shared)).toEqual(["edit", "pin", "forget", "delete"]);
  });

  it("names source chats and bots without exposing ids", () => {
    const names = {
      currentThreadId: "thread-1",
      threadTitles: new Map([["thread-2", "Launch plan"]]),
    };
    expect(durableFactSourceLabel(fact({ sourceThreadId: null }), names)).toBeNull();
    expect(durableFactSourceLabel(fact({ sourceThreadId: "thread-1" as never }), names)).toBe(
      "this chat",
    );
    expect(durableFactSourceLabel(fact({ sourceThreadId: "thread-2" as never }), names)).toBe(
      "Launch plan",
    );
    expect(durableFactSourceLabel(fact({ sourceThreadId: "thread-9" as never }), names)).toBe(
      "another chat",
    );
    const bots = { currentBotId: "bot-1", botNames: new Map([["bot-2", "Iris"]]) };
    expect(durableFactBotsLabel(fact({ affectedBotIds: [] }), bots)).toBeNull();
    expect(
      durableFactBotsLabel(fact({ affectedBotIds: ["bot-1", "bot-2", "bot-8"] as never }), bots),
    ).toBe("this bot, Iris, another bot");
    expect(durableFactBotsLabel(fact({ affectedBotIds: ["bot-8", "bot-9"] as never }), bots)).toBe(
      "2 other bots",
    );
  });

  it("names provenance fallbacks and bot counts in the client's language", () => {
    const i18n = createTranslator("zh-CN", {
      "this chat": "此聊天",
      "another chat": "另一个聊天",
      "this bot": "此机器人",
      "another bot": "另一个机器人",
      "{count} other bots": "其他 {count} 个机器人",
      ", ": "、",
    });
    const names = { currentThreadId: "thread-1", threadTitles: new Map<string, string>() };
    expect(durableFactSourceLabel(fact({ sourceThreadId: "thread-1" as never }), names, i18n)).toBe(
      "此聊天",
    );
    expect(durableFactSourceLabel(fact({ sourceThreadId: "thread-9" as never }), names, i18n)).toBe(
      "另一个聊天",
    );
    const bots = { currentBotId: "bot-1", botNames: new Map([["bot-2", "Iris"]]) };
    expect(
      durableFactBotsLabel(
        fact({ affectedBotIds: ["bot-1", "bot-2", "bot-8"] as never }),
        bots,
        i18n,
      ),
    ).toBe("此机器人、Iris、另一个机器人");
    expect(
      durableFactBotsLabel(
        fact({ affectedBotIds: ["bot-7", "bot-8", "bot-9"] as never }),
        bots,
        i18n,
      ),
    ).toBe("其他 3 个机器人");
  });

  it("builds each mutation against the revision the user saw", () => {
    const current = fact();
    const target = { memoryId: "root-1", expectedRevision: 3 };
    expect(durableFactMutation(current, { action: "edit", fact: "  Prefers bullets. " })).toEqual({
      operation: "fact.edit",
      ...target,
      fact: "Prefers bullets.",
    });
    expect(durableFactMutation(current, { action: "unpin" })).toEqual({
      operation: "fact.pin",
      ...target,
      pinned: false,
    });
    expect(durableFactMutation(current, { action: "move", scope: "project" })).toEqual({
      operation: "fact.scope",
      ...target,
      scope: "project",
    });
    expect(durableFactMutation(current, { action: "approve" })).toEqual({
      operation: "fact.decide",
      ...target,
      decision: "approve",
    });
    expect(durableFactMutation(current, { action: "forget" })).toEqual({
      operation: "fact.forget",
      ...target,
    });
    expect(durableFactMutation(current, { action: "delete" })).toEqual({
      operation: "fact.delete",
      ...target,
    });
  });

  it("omits the current scope from move targets and rejects empty or unchanged edits", () => {
    expect(durableFactMoveScopes(fact(), OPEN).map((option) => option.scope)).toEqual([
      "bot",
      "project",
    ]);
    expect(
      durableFactMoveScopes(fact({ scope: "project" }), OPEN).map((option) => option.scope),
    ).toEqual(["private", "bot"]);
    expect(canSaveDurableFactEdit(fact(), "  ")).toBe(false);
    expect(canSaveDurableFactEdit(fact(), " Prefers short replies. ")).toBe(false);
    expect(canSaveDurableFactEdit(fact(), "Prefers bullets.")).toBe(true);
  });

  it("names revision conflicts and missing operate access plainly", () => {
    expect(
      describeDurableFactFailure({
        _tag: "AkeruMemoryOperationError",
        operation: "facts.mutate",
        detail: "Memory revision conflict for root-1. Expected 3, found 4.",
      }),
    ).toEqual({ conflict: true, message: DURABLE_FACT_CONFLICT_MESSAGE, detail: null });
    expect(
      describeDurableFactFailure({
        _tag: "EnvironmentAuthorizationError",
        message: "Missing scope",
        requiredScope: "orchestration:operate",
      }).message,
    ).toBe("This connection can read memory but not change it.");
    expect(
      describeDurableFactFailure({
        _tag: "AkeruMemoryOperationError",
        detail: "Memory is turned off.",
      }),
    ).toEqual({
      conflict: false,
      message: "The fact could not be updated.",
      detail: "Memory is turned off.",
    });
  });
});

describe("shared memory approvals", () => {
  const request = (candidateId: string, fact: string) => ({
    candidateId: AkeruMemoryCandidateId.make(candidateId),
    fact,
    scope: "project" as const,
    sensitive: false,
    sourceThreadId: ThreadId.make("thread-1"),
    authorBotId: BotId.make("bot-ada"),
    affectedBotIds: [BotId.make("bot-ada")],
  });

  it("keeps only requests without a decision, once each, and ignores malformed payloads", () => {
    const first = request("candidate-1", "Deploys happen on Fridays.");
    const second = request("candidate-2", "The team uses pnpm.");
    const activities = [
      { kind: AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY, payload: first },
      { kind: AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY, payload: second },
      { kind: AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY, payload: second },
      { kind: AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY, payload: { candidateId: 3 } },
      { kind: "tool.completed", payload: first },
      {
        kind: AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY,
        payload: {
          candidateId: first.candidateId,
          status: "approved",
          fact: first.fact,
          scope: "project",
          affectedBotIds: first.affectedBotIds,
          memoryRootId: null,
          createdAt: "2026-09-23T08:00:00.000Z",
        },
      },
    ];
    expect(pendingMemoryApprovals(activities)).toEqual([second]);
    expect(pendingMemoryApprovals([])).toEqual([]);
  });

  it("builds approve, edit-and-approve, and reject decisions", () => {
    const pending = request("candidate-1", "Deploys happen on Fridays.");
    expect(memoryApprovalHeading("project")).toBe("Save to project memory?");
    expect(memoryApprovalHeading("bot")).toBe("Save to this bot's memory?");
    expect(memoryApprovalHeading("project", createTranslator("zh-CN", zhCNCatalog))).toBe(
      "要保存到项目记忆吗？",
    );
    expect(memoryApprovalMutation(pending, { action: "approve" })).toEqual({
      operation: "candidate.decide",
      decision: { candidateId: pending.candidateId, decision: "approve" },
    });
    expect(
      memoryApprovalMutation(pending, { action: "approve", fact: " Deploys happen on Mondays. " }),
    ).toEqual({
      operation: "candidate.decide",
      decision: {
        candidateId: pending.candidateId,
        decision: "approve",
        fact: "Deploys happen on Mondays.",
      },
    });
    expect(
      memoryApprovalMutation(pending, { action: "approve", fact: "Deploys happen on Fridays." }),
    ).toEqual({
      operation: "candidate.decide",
      decision: { candidateId: pending.candidateId, decision: "approve" },
    });
    expect(memoryApprovalMutation(pending, { action: "reject" })).toEqual({
      operation: "candidate.decide",
      decision: { candidateId: pending.candidateId, decision: "reject" },
    });
  });
});
