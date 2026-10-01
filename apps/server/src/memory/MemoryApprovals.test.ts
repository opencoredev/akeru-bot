import {
  botId,
  threadId,
  access,
  dispatched,
  testLayer,
  inbox,
  activityKinds,
} from "./testUtils/memoryApprovals.ts";
import { assert, it } from "@effect/vitest";
import {
  AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY,
  AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY,
  AkeruMemoryCandidateId,
  BotId,
  GroupId,
  ThreadId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MemoryApprovals, memoryApprovalIncidentKey } from "./MemoryApprovals.ts";
import { EntityMemoryRepository } from "./Services/EntityMemoryRepository.ts";
it.layer(testLayer)("MemoryApprovals", (it) => {
  it.effect("holds a shared fact for approval and saves it once approved", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      const approvals = yield* MemoryApprovals;
      const repository = yield* EntityMemoryRepository;

      const proposed = yield* approvals.propose({
        access,
        fact: "The release branch is cut on Thursdays.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });
      assert.equal(proposed.status, "pending");
      if (proposed.status !== "pending") return;

      const requested = dispatched[0];
      assert.equal(requested?.type, "thread.activity.append");
      if (requested?.type !== "thread.activity.append") return;
      assert.equal(requested.threadId, threadId);
      assert.equal(requested.activity.kind, AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY);
      assert.equal(requested.activity.tone, "approval");
      assert.equal(requested.activity.summary, "Save to project memory?");
      assert.deepEqual(requested.activity.payload, {
        candidateId: proposed.candidateId,
        fact: "The release branch is cut on Thursdays.",
        scope: "project",
        sensitive: false,
        sourceThreadId: threadId,
        authorBotId: botId,
        affectedBotIds: [botId],
      });

      const botInbox = yield* inbox;
      const openItem = botInbox
        .list()
        .find((item) => item.incidentKey === memoryApprovalIncidentKey(proposed.candidateId));
      assert.equal(openItem?.kind, "approval-request");
      assert.equal(openItem?.status, "open");
      assert.equal(openItem?.botName, "Ada");
      assert.equal(openItem?.taskOrRoutine, "Release notes");
      assert.equal(openItem?.memoryApproval?.candidateId, proposed.candidateId);
      assert.equal((yield* repository.listCurrent({ access })).length, 0);
      // Generic inbox dismissal cannot close an undecided memory approval.
      assert.equal(botInbox.resolveById(openItem!.id), false);
      assert.equal(botInbox.list().find((item) => item.id === openItem!.id)?.status, "open");

      const receipt = yield* approvals.decide({
        access,
        decision: {
          candidateId: proposed.candidateId,
          decision: "approve",
          fact: "The release branch is cut on Thursday mornings.",
          scope: "project",
        },
      });
      assert.equal(receipt.status, "approved");
      assert.equal(receipt.fact, "The release branch is cut on Thursday mornings.");
      assert.isNotNull(receipt.memoryRootId);

      const saved = yield* repository.listCurrent({ access });
      assert.deepEqual(
        saved.map((revision) => [revision.fact, revision.partition.scope, revision.approvalState]),
        [["The release branch is cut on Thursday mornings.", "project", "approved"]],
      );
      assert.deepEqual(activityKinds(), [
        AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY,
        AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY,
      ]);
      botInbox.reload();
      assert.equal(
        botInbox
          .list()
          .find((item) => item.incidentKey === memoryApprovalIncidentKey(proposed.candidateId))
          ?.status,
        "resolved",
      );

      // A second decision from the other surface returns the first receipt.
      const repeated = yield* approvals.decide({
        access,
        decision: { candidateId: proposed.candidateId, decision: "reject" },
      });
      assert.deepEqual(repeated, receipt);
      assert.equal((yield* repository.listCurrent({ access })).length, 1);
    }),
  );

  it.effect("rejects without saving and refuses decisions from another chat", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      const approvals = yield* MemoryApprovals;
      const repository = yield* EntityMemoryRepository;
      const before = (yield* repository.listCurrent({ access })).length;

      const proposed = yield* approvals.propose({
        access,
        fact: "The staging password lives in the vault.",
        scope: "workspace",
        sensitive: true,
        mode: "auto",
      });
      assert.equal(proposed.status, "pending");
      if (proposed.status !== "pending") return;

      const foreign = yield* approvals
        .decide({
          access: { ...access, threadId: ThreadId.make("thread-other") },
          decision: { candidateId: proposed.candidateId, decision: "approve" },
        })
        .pipe(Effect.flip);
      assert.equal(foreign._tag, "MemoryApprovalError");

      const receipt = yield* approvals.decide({
        access,
        decision: { candidateId: proposed.candidateId, decision: "reject" },
      });
      assert.equal(receipt.status, "rejected");
      assert.isNull(receipt.memoryRootId);
      assert.equal((yield* repository.listCurrent({ access })).length, before);

      const unknown = yield* approvals
        .decide({
          access,
          decision: { candidateId: AkeruMemoryCandidateId.make("missing"), decision: "approve" },
        })
        .pipe(Effect.flip);
      assert.equal(unknown._tag, "MemoryApprovalError");
    }),
  );

  it.effect("rejects a client scope that differs from the candidate", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;
      const proposed = yield* approvals.propose({
        access,
        fact: "The release bot owns the project checklist.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });
      assert.equal(proposed.status, "pending");
      if (proposed.status !== "pending") return;
      const error = yield* approvals
        .decide({
          access,
          decision: {
            candidateId: proposed.candidateId,
            decision: "approve",
            scope: "workspace",
          },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "MemoryApprovalError");
      assert.match(error.message, /scope must match/);
    }),
  );

  it.effect("saves a group approval under the bot that asked", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;
      const repository = yield* EntityMemoryRepository;
      const otherBotId = BotId.make("bot-bob");
      const groupAccess = {
        ...access,
        groupId: GroupId.make("group-release"),
        respondingBotId: botId,
        groupMemberBotIds: [botId, otherBotId],
      };
      const proposed = yield* approvals.propose({
        access: groupAccess,
        fact: "Ada owns the release checklist.",
        scope: "group",
        sensitive: false,
        mode: "ask",
      });
      assert.equal(proposed.status, "pending");
      if (proposed.status !== "pending") return;
      const decided = yield* approvals.decide({
        access: { ...groupAccess, respondingBotId: otherBotId },
        decision: { candidateId: proposed.candidateId, decision: "approve" },
      });
      assert.equal(decided.status, "approved");
      if (decided.memoryRootId === null) return assert.fail("expected a saved memory");
      const saved = yield* repository.getCurrent({
        access: groupAccess,
        rootId: decided.memoryRootId,
      });
      assert.equal(saved.authorBotId, botId);
    }),
  );

  it.effect("lets the chat decide after the asking bot leaves the group", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;
      const otherBotId = BotId.make("bot-bob");
      const groupAccess = {
        ...access,
        groupId: GroupId.make("group-release"),
        respondingBotId: botId,
        groupMemberBotIds: [botId, otherBotId],
      };
      const departedAccess = {
        ...groupAccess,
        respondingBotId: otherBotId,
        groupMemberBotIds: [otherBotId],
      };
      for (const decision of ["approve", "reject"] as const) {
        const proposed = yield* approvals.propose({
          access: groupAccess,
          fact: `Ada owns the ${decision} checklist.`,
          scope: "group",
          sensitive: false,
          mode: "ask",
        });
        if (proposed.status !== "pending") return assert.fail("expected a pending request");
        const decided = yield* approvals.decide({
          access: departedAccess,
          decision: { candidateId: proposed.candidateId, decision },
        });
        assert.equal(decided.status, decision === "approve" ? "approved" : "rejected");
      }
    }),
  );

  it.effect("refuses to hold a request for a scope the chat does not have", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;
      const sql = yield* SqlClient.SqlClient;
      const error = yield* approvals
        .propose({
          access,
          fact: "The group ships on Mondays.",
          scope: "group",
          sensitive: false,
          mode: "ask",
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "MemoryApprovalError");
      const rows = yield* sql`
        SELECT candidate_id FROM akeru_memory_candidates
        WHERE fact_text = 'The group ships on Mondays.'
      `;
      assert.equal(rows.length, 0);
    }),
  );

  it.effect("rejects an edited fact that fails the memory content guard", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;
      const proposed = yield* approvals.propose({
        access,
        fact: "The docs live in the handbook.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });
      assert.equal(proposed.status, "pending");
      if (proposed.status !== "pending") return;
      const error = yield* approvals
        .decide({
          access,
          decision: {
            candidateId: proposed.candidateId,
            decision: "approve",
            fact: "Hidden\u200bnote",
          },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "MemoryApprovalError");
      assert.match(error.message, /Memory content was rejected/);
    }),
  );

  it.effect("saves a non-sensitive fact directly in auto mode", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      const approvals = yield* MemoryApprovals;
      const repository = yield* EntityMemoryRepository;

      const saved = yield* approvals.propose({
        access,
        fact: "Pull requests need one reviewer.",
        scope: "workspace",
        sensitive: false,
        mode: "auto",
      });
      assert.equal(saved.status, "saved");
      assert.deepEqual(activityKinds(), []);
      const current = yield* repository.listCurrent({ access });
      assert.isTrue(
        current.some(
          (revision) =>
            revision.fact === "Pull requests need one reviewer." &&
            revision.partition.scope === "workspace",
        ),
      );
    }),
  );
});
