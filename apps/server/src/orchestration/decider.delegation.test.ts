import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  CommandId,
  DelegationId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AkeruDelegationRecord,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-31T12:00:00.000Z";
const LATER = "2026-08-31T12:01:00.000Z";
const PARENT_BOT_ID = BotId.make("bot-parent");
const CHILD_BOT_ID = BotId.make("bot-child");
const OTHER_BOT_ID = BotId.make("bot-other");
const PARENT_THREAD_ID = ThreadId.make("thread-parent");
const CHILD_THREAD_ID = ThreadId.make("thread-child");
type PlannedDelegationEvent = Omit<
  Extract<OrchestrationEvent, { type: "delegation.created" | "delegation.updated" }>,
  "sequence"
>;

function makeBot(id: BotId): OrchestrationBot {
  return {
    id,
    name: id,
    title: "Agent",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "dither", seed: id },
    engine: null,
    sandbox: "local",
    runtimeMode: "approval-required",
    usageCap: null,
    voiceEnabled: false,
    groupId: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeThread(id: ThreadId, botId: BotId): OrchestrationThread {
  return {
    id,
    projectId: ProjectId.make("project-1"),
    botId,
    groupId: null,
    respondingBotId: null,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeDelegation(overrides: Partial<AkeruDelegationRecord> = {}): AkeruDelegationRecord {
  return {
    delegationId: DelegationId.make("delegation-1"),
    parentDelegationId: null,
    parentBotId: PARENT_BOT_ID,
    childBotId: CHILD_BOT_ID,
    parentThreadId: PARENT_THREAD_ID,
    childThreadId: null,
    parentTurnId: TurnId.make("turn-parent"),
    childTurnId: null,
    ancestorBotIds: [PARENT_BOT_ID],
    depth: 1,
    task: "Compare three flights.",
    expectedResult: "A short comparison with sources.",
    deadline: null,
    access: {
      allowedToolIds: ["Read"],
      memoryScopes: ["project"],
      sandbox: "daytona",
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "send",
    },
    state: "queued",
    billedBotId: CHILD_BOT_ID,
    result: null,
    failure: null,
    keep: false,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeReadModel(
  delegations: ReadonlyArray<AkeruDelegationRecord> = [],
): OrchestrationReadModel {
  return {
    ...createEmptyReadModel(NOW),
    bots: [makeBot(PARENT_BOT_ID), makeBot(CHILD_BOT_ID), makeBot(OTHER_BOT_ID)],
    threads: [
      makeThread(PARENT_THREAD_ID, PARENT_BOT_ID),
      makeThread(CHILD_THREAD_ID, CHILD_BOT_ID),
    ],
    delegations,
  };
}

const decideOne = Effect.fn("decideDelegationTestCommand")(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const decided = yield* decideOrchestrationCommand({ readModel, command });
  const event = Array.isArray(decided) ? decided[0] : decided;
  if (event === undefined) throw new Error("Expected one event");
  if (event.type !== "delegation.created" && event.type !== "delegation.updated") {
    throw new Error(`Expected a delegation event, received '${event.type}'`);
  }
  return event as PlannedDelegationEvent;
});

const project = Effect.fn("projectDelegationTestEvent")(function* (
  readModel: OrchestrationReadModel,
  event: PlannedDelegationEvent,
) {
  return yield* projectEvent(readModel, {
    ...event,
    sequence: readModel.snapshotSequence + 1,
  });
});

it.layer(NodeServices.layer)("delegation decider", (it) => {
  it.effect("creates and projects the full delegation record", () =>
    Effect.gen(function* () {
      const delegation = makeDelegation();
      const event = yield* decideOne(makeReadModel(), {
        type: "delegation.create",
        commandId: CommandId.make("command-create"),
        delegation,
      });

      expect(event).toMatchObject({
        type: "delegation.created",
        aggregateKind: "delegation",
        aggregateId: delegation.delegationId,
        payload: { delegation },
      });
      const projected = yield* project(makeReadModel(), event);
      expect(projected.delegations).toEqual([delegation]);
    }),
  );

  it.effect("accepts every legal state and cancels unfinished work idempotently", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel([makeDelegation()]);
      const states: AkeruDelegationRecord["state"][] = ["queued"];
      const update = Effect.fn("updateDelegationState")(function* (
        delegation: AkeruDelegationRecord,
        commandId: string,
      ) {
        const event = yield* decideOne(readModel, {
          type: "delegation.state.set",
          commandId: CommandId.make(commandId),
          delegation,
        });
        readModel = yield* project(readModel, event);
        states.push(delegation.state);
      });

      const running = makeDelegation({
        childThreadId: CHILD_THREAD_ID,
        childTurnId: TurnId.make("turn-child"),
        state: "running",
        updatedAt: LATER,
        startedAt: LATER,
      });
      yield* update(running, "command-running");
      yield* update({ ...running, state: "blocked" }, "command-blocked");
      yield* update(running, "command-resumed");
      yield* update(
        {
          ...running,
          state: "completed",
          result: {
            summary: "Compared the flights.",
            childThreadId: CHILD_THREAD_ID,
            childTurnId: running.childTurnId,
          },
          completedAt: "2026-08-31T12:02:00.000Z",
          updatedAt: "2026-08-31T12:02:00.000Z",
        },
        "command-completed",
      );
      expect(states).toEqual(["queued", "running", "blocked", "running", "completed"]);

      const failed = makeDelegation({
        state: "failed",
        failure: { failureCode: "internal", message: "Child process failed." },
        completedAt: LATER,
        updatedAt: LATER,
      });
      const failedEvent = yield* decideOne(makeReadModel([makeDelegation()]), {
        type: "delegation.state.set",
        commandId: CommandId.make("command-failed"),
        delegation: failed,
      });
      expect(failedEvent.payload.delegation.state).toBe("failed");

      const cancelEvent = yield* decideOne(makeReadModel([makeDelegation()]), {
        type: "delegation.cancel",
        commandId: CommandId.make("command-cancel"),
        delegationId: DelegationId.make("delegation-1"),
        keep: false,
        createdAt: LATER,
      });
      expect(cancelEvent.payload.delegation.state).toBe("canceled");

      const keepEvent = yield* decideOne(makeReadModel([makeDelegation()]), {
        type: "delegation.cancel",
        commandId: CommandId.make("command-keep"),
        delegationId: DelegationId.make("delegation-1"),
        keep: true,
        createdAt: LATER,
      });
      expect(keepEvent.payload.delegation).toMatchObject({ state: "queued", keep: true });

      const canceledModel = yield* project(makeReadModel([makeDelegation()]), cancelEvent);
      const repeated = yield* decideOne(canceledModel, {
        type: "delegation.cancel",
        commandId: CommandId.make("command-cancel-again"),
        delegationId: DelegationId.make("delegation-1"),
        keep: false,
        createdAt: "2026-08-31T12:03:00.000Z",
      });
      expect(repeated.payload.delegation).toEqual(cancelEvent.payload.delegation);
    }),
  );

  it.effect("assigns child ownership once and keeps lifecycle timestamps monotonic", () =>
    Effect.gen(function* () {
      const running = makeDelegation({
        childThreadId: CHILD_THREAD_ID,
        state: "running",
        updatedAt: LATER,
        startedAt: LATER,
      });
      const assigned = {
        ...running,
        childTurnId: TurnId.make("turn-child"),
        updatedAt: "2026-08-31T12:02:00.000Z",
      };
      const assignedEvent = yield* decideOne(makeReadModel([running]), {
        type: "delegation.state.set",
        commandId: CommandId.make("command-assign-child-turn"),
        delegation: assigned,
      });
      expect(assignedEvent.payload.delegation).toEqual(assigned);

      const cancelEvent = yield* decideOne(makeReadModel([assigned]), {
        type: "delegation.cancel",
        commandId: CommandId.make("command-stale-cancel"),
        delegationId: assigned.delegationId,
        keep: false,
        createdAt: NOW,
      });
      expect(cancelEvent.payload.delegation).toMatchObject({
        state: "canceled",
        updatedAt: assigned.updatedAt,
        completedAt: assigned.updatedAt,
      });
    }),
  );

  it.effect("rejects cycles, bad depth, missing records, and excess concurrency", () =>
    Effect.gen(function* () {
      const parent = makeDelegation();
      const cycle = makeDelegation({
        delegationId: DelegationId.make("delegation-cycle"),
        parentDelegationId: parent.delegationId,
        parentBotId: CHILD_BOT_ID,
        childBotId: PARENT_BOT_ID,
        parentThreadId: CHILD_THREAD_ID,
        childThreadId: PARENT_THREAD_ID,
        ancestorBotIds: [PARENT_BOT_ID, CHILD_BOT_ID],
        depth: 2,
        billedBotId: PARENT_BOT_ID,
      });
      const cycleError = yield* decideOrchestrationCommand({
        readModel: makeReadModel([parent]),
        command: {
          type: "delegation.create",
          commandId: CommandId.make("command-cycle"),
          delegation: cycle,
        },
      }).pipe(Effect.flip);
      expect(String(cycleError)).toContain("cycle");

      const depthError = yield* decideOrchestrationCommand({
        readModel: makeReadModel(),
        command: {
          type: "delegation.create",
          commandId: CommandId.make("command-depth"),
          delegation: makeDelegation({ depth: 2 }),
        },
      }).pipe(Effect.flip);
      expect(String(depthError)).toContain("ancestor chain or depth");

      const missingError = yield* decideOrchestrationCommand({
        readModel: makeReadModel(),
        command: {
          type: "delegation.create",
          commandId: CommandId.make("command-missing"),
          delegation: makeDelegation({ childBotId: BotId.make("bot-missing") }),
        },
      }).pipe(Effect.flip);
      expect(String(missingError)).toContain("bot-missing");

      const archivedChildError = yield* decideOrchestrationCommand({
        readModel: {
          ...makeReadModel(),
          bots: [
            makeBot(PARENT_BOT_ID),
            { ...makeBot(CHILD_BOT_ID), archivedAt: LATER },
            makeBot(OTHER_BOT_ID),
          ],
        },
        command: {
          type: "delegation.create",
          commandId: CommandId.make("command-archived-child"),
          delegation: makeDelegation(),
        },
      }).pipe(Effect.flip);
      expect(String(archivedChildError)).toContain("archived");

      const active = [1, 2, 3].map((index) =>
        makeDelegation({ delegationId: DelegationId.make(`delegation-${index}`) }),
      );
      const concurrencyError = yield* decideOrchestrationCommand({
        readModel: makeReadModel(active),
        command: {
          type: "delegation.create",
          commandId: CommandId.make("command-concurrency"),
          delegation: makeDelegation({ delegationId: DelegationId.make("delegation-4") }),
        },
      }).pipe(Effect.flip);
      expect(String(concurrencyError)).toContain("3 active delegations");
    }),
  );

  it.effect("rejects illegal transitions and ownership changes", () =>
    Effect.gen(function* () {
      const queued = makeDelegation();
      const completed = makeDelegation({
        childThreadId: CHILD_THREAD_ID,
        state: "completed",
        startedAt: NOW,
        completedAt: LATER,
        updatedAt: LATER,
        result: {
          summary: "Done.",
          childThreadId: CHILD_THREAD_ID,
          childTurnId: null,
        },
      });
      const transitionError = yield* decideOrchestrationCommand({
        readModel: makeReadModel([queued]),
        command: {
          type: "delegation.state.set",
          commandId: CommandId.make("command-illegal"),
          delegation: completed,
        },
      }).pipe(Effect.flip);
      expect(String(transitionError)).toContain("cannot transition");

      const ownershipError = yield* decideOrchestrationCommand({
        readModel: makeReadModel([queued]),
        command: {
          type: "delegation.state.set",
          commandId: CommandId.make("command-owner-change"),
          delegation: makeDelegation({
            childBotId: OTHER_BOT_ID,
            billedBotId: OTHER_BOT_ID,
          }),
        },
      }).pipe(Effect.flip);
      expect(String(ownershipError)).toContain("immutable");
    }),
  );
});
