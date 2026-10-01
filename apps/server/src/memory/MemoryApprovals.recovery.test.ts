import { failureInjection } from "./testUtils/memoryApprovals.ts";
import { access, testLayer, inbox } from "./testUtils/memoryApprovals.ts";
import { assert, it } from "@effect/vitest";
import { AkeruMemoryId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { MemoryApprovals, memoryApprovalIncidentKey } from "./MemoryApprovals.ts";
import { EntityMemoryRepository } from "./Services/EntityMemoryRepository.ts";

it.layer(testLayer)("MemoryApprovals", (it) => {
  it.effect("reconciles inbox and activity after a lost first side effect", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;
      const botInbox = yield* inbox;

      const proposed = yield* approvals.propose({
        access,
        fact: "The release bot owns the project checklist.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });

      assert.equal(proposed.status, "pending");

      if (proposed.status !== "pending") return;
      failureInjection.failResolvedActivityOnce = true;

      const first = yield* approvals
        .decide({ access, decision: { candidateId: proposed.candidateId, decision: "approve" } })
        .pipe(Effect.flip);

      assert.equal(first._tag, "MemoryApprovalError");
      botInbox.reload();
      assert.equal(
        botInbox
          .list()
          .find((item) => item.incidentKey === memoryApprovalIncidentKey(proposed.candidateId))
          ?.status,
        "open",
      );

      const retry = yield* approvals.decide({
        access,
        decision: { candidateId: proposed.candidateId, decision: "approve" },
      });

      assert.equal(retry.status, "approved");
      botInbox.reload();
      assert.equal(
        botInbox
          .list()
          .find((item) => item.incidentKey === memoryApprovalIncidentKey(proposed.candidateId))
          ?.status,
        "resolved",
      );
    }),
  );

  it.effect("reconciles an approved revision left behind by a crash", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;
      const repository = yield* EntityMemoryRepository;

      const proposed = yield* approvals.propose({
        access,
        fact: "The release train runs on Fridays.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });

      assert.equal(proposed.status, "pending");

      if (proposed.status !== "pending") return;
      yield* repository.insertScopedFact({
        access,
        scope: "project",
        fact: "The release train runs on Fridays.",
        sensitive: false,
        confidence: 1,
        sourceMessageId: null,
        memoryId: AkeruMemoryId.make(`approval:${proposed.candidateId}`),
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const receipt = yield* approvals.decide({
        access,
        decision: { candidateId: proposed.candidateId, decision: "approve" },
      });

      assert.equal(receipt.status, "approved");
      assert.equal(receipt.fact, "The release train runs on Fridays.");
      assert.equal(receipt.scope, "project");
      assert.isTrue(
        (yield* repository.listCurrent({ access })).some(
          (revision) => revision.fact === "The release train runs on Fridays.",
        ),
      );
    }),
  );

  it.effect("retries an approve after the scoped fact write crashes", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;

      const proposed = yield* approvals.propose({
        access,
        fact: "The release train runs after review.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });

      assert.equal(proposed.status, "pending");

      if (proposed.status !== "pending") return;
      failureInjection.crashAfterScopedFactOnce = true;

      const failed = yield* Effect.exit(
        approvals.decide({
          access,
          decision: { candidateId: proposed.candidateId, decision: "approve" },
        }),
      );

      assert.equal(failed._tag, "Failure");

      const retry = yield* approvals.decide({
        access,
        decision: { candidateId: proposed.candidateId, decision: "approve" },
      });

      assert.equal(retry.status, "approved");
    }),
  );

  it.effect("does not approve a tombstone after a rejected retract crashes", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;
      const repository = yield* EntityMemoryRepository;

      const proposed = yield* approvals.propose({
        access,
        fact: "The release train runs after review.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });

      assert.equal(proposed.status, "pending");

      if (proposed.status !== "pending") return;

      const first = yield* approvals.decide({
        access,
        decision: { candidateId: proposed.candidateId, decision: "approve" },
      });

      assert.equal(first.status, "approved");

      // Recreate the pending crash window with a fresh candidate and an orphan.
      const second = yield* approvals.propose({
        access,
        fact: "The release train runs before lunch.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });

      assert.equal(second.status, "pending");

      if (second.status !== "pending") return;
      yield* repository.insertScopedFact({
        access,
        scope: "project",
        fact: "The release train runs before lunch.",
        sensitive: false,
        confidence: 1,
        sourceMessageId: null,
        memoryId: AkeruMemoryId.make(`approval:${second.candidateId}`),
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      failureInjection.crashAfterRetractOnce = true;

      const rejected = yield* Effect.exit(
        approvals.decide({
          access,
          decision: { candidateId: second.candidateId, decision: "reject" },
        }),
      );

      assert.equal(rejected._tag, "Failure");

      const competing = yield* approvals
        .decide({ access, decision: { candidateId: second.candidateId, decision: "approve" } })
        .pipe(Effect.flip);

      assert.equal(competing._tag, "MemoryApprovalError");
      assert.match(competing.message, /different approved fact or scope/);
    }),
  );

  it.effect("retries a rejection after its retract crashed", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;
      const repository = yield* EntityMemoryRepository;

      const proposed = yield* approvals.propose({
        access,
        fact: "The release train leaves at noon.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });

      assert.equal(proposed.status, "pending");

      if (proposed.status !== "pending") return;
      yield* repository.insertScopedFact({
        access,
        scope: "project",
        fact: "The release train leaves at noon.",
        sensitive: false,
        confidence: 1,
        sourceMessageId: null,
        memoryId: AkeruMemoryId.make(`approval:${proposed.candidateId}`),
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      failureInjection.crashAfterRetractOnce = true;

      const crashed = yield* Effect.exit(
        approvals.decide({
          access,
          decision: { candidateId: proposed.candidateId, decision: "reject" },
        }),
      );

      assert.equal(crashed._tag, "Failure");

      const retried = yield* approvals.decide({
        access,
        decision: { candidateId: proposed.candidateId, decision: "reject" },
      });

      assert.equal(retried.status, "rejected");
    }),
  );

  it.effect("reconciles an approve crash followed by reject as rejected", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;

      const proposed = yield* approvals.propose({
        access,
        fact: "The release train runs after review.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });

      assert.equal(proposed.status, "pending");

      if (proposed.status !== "pending") return;
      failureInjection.crashAfterScopedFactOnce = true;

      const failed = yield* Effect.exit(
        approvals.decide({
          access,
          decision: { candidateId: proposed.candidateId, decision: "approve" },
        }),
      );

      assert.equal(failed._tag, "Failure");

      const rejected = yield* approvals.decide({
        access,
        decision: { candidateId: proposed.candidateId, decision: "reject" },
      });

      assert.equal(rejected.status, "rejected");
      assert.isNull(rejected.memoryRootId);
    }),
  );

  it.effect("rejects a divergent retry without changing the orphaned approval", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;
      const repository = yield* EntityMemoryRepository;

      const proposed = yield* approvals.propose({
        access,
        fact: "The release train runs on Mondays.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });

      assert.equal(proposed.status, "pending");

      if (proposed.status !== "pending") return;
      yield* repository.insertScopedFact({
        access,
        scope: "project",
        fact: "The release train runs on Mondays.",
        sensitive: false,
        confidence: 1,
        sourceMessageId: null,
        memoryId: AkeruMemoryId.make(`approval:${proposed.candidateId}`),
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const error = yield* approvals
        .decide({
          access,
          decision: {
            candidateId: proposed.candidateId,
            decision: "approve",
            fact: "The release train runs on Tuesdays.",
          },
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "MemoryApprovalError");
      assert.match(error.message, /different approved fact or scope/);
      assert.isTrue(
        (yield* repository.listCurrent({ access })).some(
          (revision) => revision.fact === "The release train runs on Mondays.",
        ),
      );
    }),
  );

  it.effect("retracts an orphaned approval when the pending candidate is rejected", () =>
    Effect.gen(function* () {
      const approvals = yield* MemoryApprovals;
      const repository = yield* EntityMemoryRepository;

      const proposed = yield* approvals.propose({
        access,
        fact: "The release train runs on Wednesdays.",
        scope: "project",
        sensitive: false,
        mode: "ask",
      });

      assert.equal(proposed.status, "pending");

      if (proposed.status !== "pending") return;
      yield* repository.insertScopedFact({
        access,
        scope: "project",
        fact: "The release train runs on Wednesdays.",
        sensitive: false,
        confidence: 1,
        sourceMessageId: null,
        memoryId: AkeruMemoryId.make(`approval:${proposed.candidateId}`),
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const receipt = yield* approvals.decide({
        access,
        decision: { candidateId: proposed.candidateId, decision: "reject" },
      });

      assert.equal(receipt.status, "rejected");
      assert.isNull(receipt.memoryRootId);
      assert.isFalse(
        (yield* repository.listCurrent({ access })).some(
          (revision) => revision.fact === "The release train runs on Wednesdays.",
        ),
      );
    }),
  );
});
