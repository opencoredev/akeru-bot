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
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-31T12:00:00.000Z";
const LATER = "2026-08-31T12:01:00.000Z";
const SOURCE_BOT_ID = BotId.make("bot-source");
const TARGET_BOT_ID = BotId.make("bot-target");
const SOURCE_THREAD_ID = ThreadId.make("thread-source");
const CHILD_THREAD_ID = ThreadId.make("thread-child");
const SOURCE_TURN_ID = TurnId.make("turn-source");
const CHILD_TURN_ID = TurnId.make("turn-child");

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
    runtimeMode: "full-access",
    usageCap: null,
    voiceEnabled: false,
    groupId: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeThread(input: {
  id: ThreadId;
  botId: BotId;
  turnId: TurnId | null;
  projectId?: ProjectId;
}): OrchestrationThread {
  return {
    id: input.id,
    projectId: input.projectId ?? ProjectId.make("project-1"),
    botId: input.botId,
    groupId: null,
    respondingBotId: null,
    title: input.id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn:
      input.turnId === null
        ? null
        : {
            turnId: input.turnId,
            state: "running",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
            assistantMessageId: null,
          },
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

function makeDelegation(
  overrides: Partial<AkeruDelegationRecord> = {},
): AkeruDelegationRecord {
  return {
    delegationId: DelegationId.make("delegation-1"),
    sourceThreadId: SOURCE_THREAD_ID,
    sourceTurnId: SOURCE_TURN_ID,
    sourceBotId: SOURCE_BOT_ID,
    targetBotId: TARGET_BOT_ID,
    childThreadId: CHILD_THREAD_ID,
    childTurnId: null,
    depth: 1,
    billedBotId: TARGET_BOT_ID,
    task: "Compare three flights.",
    expectedResult: "A short comparison with sources.",
    outcome: null,
    createdAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

function makeReadModel(input: {
  childBotId?: BotId;
  childProjectId?: ProjectId;
  targetArchived?: boolean;
  delegations?: ReadonlyArray<AkeruDelegationRecord>;
} = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    bots: [
      makeBot(SOURCE_BOT_ID),
      {
        ...makeBot(TARGET_BOT_ID),
        archivedAt: input.targetArchived ? LATER : null,
      },
    ],
    groups: [],
    delegations: input.delegations ?? [],
    threads: [
      makeThread({ id: SOURCE_THREAD_ID, botId: SOURCE_BOT_ID, turnId: SOURCE_TURN_ID }),
      makeThread({
        id: CHILD_THREAD_ID,
        botId: input.childBotId ?? TARGET_BOT_ID,
        turnId: null,
        projectId: input.childProjectId,
      }),
    ],
    updatedAt: NOW,
  };
}

const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  decideOrchestrationCommand({ readModel, command });

it.layer(NodeServices.layer)("delegation decider", (it) => {
  it.effect("creates and completes a delegation", () =>
    Effect.gen(function* () {
      const delegation = makeDelegation();
      const created = yield* decide(makeReadModel(), {
        type: "delegation.create",
        commandId: CommandId.make("command-create"),
        delegation,
      });
      expect(created).toMatchObject({
        type: "delegation.created",
        aggregateKind: "delegation",
        aggregateId: delegation.delegationId,
        payload: { delegation },
      });

      const completedDelegation = makeDelegation({
        childTurnId: CHILD_TURN_ID,
        outcome: { status: "succeeded", result: "Compared the flights." },
        completedAt: LATER,
      });
      const completed = yield* decide(makeReadModel({ delegations: [delegation] }), {
        type: "delegation.complete",
        commandId: CommandId.make("command-complete"),
        delegation: completedDelegation,
      });
      expect(completed).toMatchObject({
        type: "delegation.completed",
        payload: { delegation: completedDelegation },
      });
    }),
  );

  it.effect("records a failed dispatch without a child turn", () =>
    Effect.gen(function* () {
      const delegation = makeDelegation();
      const failed = makeDelegation({
        outcome: { status: "failed", error: "Turn dispatch failed." },
        completedAt: LATER,
      });
      const event = yield* decide(makeReadModel({ delegations: [delegation] }), {
        type: "delegation.complete",
        commandId: CommandId.make("command-failed"),
        delegation: failed,
      });
      expect(event).toMatchObject({ type: "delegation.completed", payload: { delegation: failed } });
    }),
  );

  it.effect("rejects invalid delegation ownership and boundaries", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        command: AkeruDelegationRecord;
        readModel: OrchestrationReadModel;
        message: string;
      }> = [
        {
          command: makeDelegation({ sourceTurnId: TurnId.make("wrong-turn") }),
          readModel: makeReadModel(),
          message: "source thread, turn, and bot",
        },
        {
          command: makeDelegation({ sourceBotId: TARGET_BOT_ID }),
          readModel: makeReadModel(),
          message: "delegate to itself",
        },
        {
          command: makeDelegation(),
          readModel: makeReadModel({ childProjectId: ProjectId.make("project-2") }),
          message: "cross projects",
        },
        {
          command: makeDelegation({ depth: 3 as AkeruDelegationRecord["depth"] }),
          readModel: makeReadModel(),
          message: "maximum depth",
        },
        {
          command: makeDelegation(),
          readModel: makeReadModel({ childBotId: SOURCE_BOT_ID }),
          message: "target bot",
        },
        {
          command: makeDelegation(),
          readModel: makeReadModel({ targetArchived: true }),
          message: "archived",
        },
        {
          command: makeDelegation({ billedBotId: SOURCE_BOT_ID }),
          readModel: makeReadModel(),
          message: "must bill target bot",
        },
      ];

      for (const testCase of cases) {
        const error = yield* decide(testCase.readModel, {
          type: "delegation.create",
          commandId: CommandId.make(`command-${testCase.message.replaceAll(" ", "-")}`),
          delegation: testCase.command,
        }).pipe(Effect.flip);
        expect(error.detail).toContain(testCase.message);
      }
    }),
  );
});
