import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY,
  AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY,
  AkeruMemoryCandidateId,
  AkeruMemoryId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { BotInboxService } from "../bot-inbox/service.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationListenerCallbackError } from "../orchestration/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EntityMemoryRepositoryLive } from "./Layers/EntityMemoryRepository.ts";
import {
  MemoryApprovals,
  MemoryApprovalsLive,
  memoryApprovalIncidentKey,
} from "./MemoryApprovals.ts";
import { EntityMemoryRepository } from "./Services/EntityMemoryRepository.ts";
import { MemoryRevisionWriteLockLive } from "./Services/MemoryRevisionWriteLock.ts";

const botId = BotId.make("bot-ada");
const threadId = ThreadId.make("thread-ada");

const access = {
  tenantId: AkeruMemoryTenantId.make("tenant"),
  userId: AkeruMemoryUserId.make("user"),
  threadId,
  projectId: ProjectId.make("project"),
  workspaceRoot: "/workspace",
  legacyWorkspaceOwnerProjectId: ProjectId.make("project"),
  botId,
  groupId: null,
  respondingBotId: null,
  groupMemberBotIds: [],
} as const;

const dispatched: Array<OrchestrationCommand> = [];
let failResolvedActivityOnce = false;
let crashAfterScopedFactOnce = false;
let crashAfterRetractOnce = false;

const engineLayer = Layer.succeed(OrchestrationEngineService, {
  dispatch: (command) =>
    Effect.suspend(() => {
      if (
        failResolvedActivityOnce &&
        command.type === "thread.activity.append" &&
        command.activity.kind === AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY
      ) {
        failResolvedActivityOnce = false;
        return Effect.fail(
          new OrchestrationListenerCallbackError({
            listener: "read-model",
            detail: "simulated activity failure",
          }),
        );
      }
      return Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      });
    }),
  readEvents: () => Stream.empty,
  readThreadEvents: () => Stream.empty,
  getThreadReplayStats: () => Effect.die("unused"),
  streamDomainEvents: Stream.empty,
  subscribeDomainEvents: Effect.succeed(Stream.empty),
  latestSequence: Effect.succeed(0),
});

// Only the two reads MemoryApprovals uses to label inbox items are real.
const snapshotQuery = {
  getThreadShellById: (id: ThreadId) =>
    Effect.succeed(
      id === threadId
        ? Option.some({
            id,
            title: "Release notes",
            botId,
            respondingBotId: null,
          } as unknown as OrchestrationThreadShell)
        : Option.none(),
    ),
  getShellSnapshot: () =>
    Effect.succeed({ bots: [{ id: botId, name: "Ada" }] } as unknown as OrchestrationShellSnapshot),
} as unknown as ProjectionSnapshotQueryShape;

const repositoryLayer = EntityMemoryRepositoryLive.pipe(Layer.provide(MemoryRevisionWriteLockLive));
const crashInjectingRepositoryLayer = Layer.effect(
  EntityMemoryRepository,
  Effect.gen(function* () {
    const repository = yield* EntityMemoryRepository;
    return {
      ...repository,
      insertScopedFact: (input: Parameters<typeof repository.insertScopedFact>[0]) =>
        repository.insertScopedFact(input).pipe(
          Effect.tap(() =>
            crashAfterScopedFactOnce
              ? Effect.sync(() => {
                  crashAfterScopedFactOnce = false;
                  throw new Error("simulated crash after scoped fact write");
                })
              : Effect.void,
          ),
        ),
      applyMutation: (input: Parameters<typeof repository.applyMutation>[0]) =>
        repository.applyMutation(input).pipe(
          Effect.tap(() =>
            crashAfterRetractOnce
              ? Effect.sync(() => {
                  crashAfterRetractOnce = false;
                  throw new Error("simulated crash after retract");
                })
              : Effect.void,
          ),
        ),
    };
  }),
).pipe(Layer.provide(repositoryLayer));

const testLayer = MemoryApprovalsLive.pipe(
  Layer.provideMerge(crashInjectingRepositoryLayer),
  Layer.provideMerge(engineLayer),
  Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "akeru-memory-approvals-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const inbox = Effect.map(ServerConfig, (config) =>
  BotInboxService.forSecretsDir(config.secretsDir),
);

const activityKinds = () =>
  dispatched.flatMap((command) =>
    command.type === "thread.activity.append" ? [command.activity.kind] : [],
  );

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
      failResolvedActivityOnce = true;
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
      crashAfterScopedFactOnce = true;
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
      crashAfterRetractOnce = true;
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
      crashAfterScopedFactOnce = true;
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
