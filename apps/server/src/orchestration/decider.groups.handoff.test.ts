import {
  type BotId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@akeru/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { GROUP_HANDOFF_BUSY_MESSAGE } from "./groupResponder.ts";
import {
  BOSS_ID,
  GROUP_ID,
  NOW,
  SPECIALIST_ID,
  makeBot,
  makeGroup,
  makeGroupThread,
  makeReadModel,
  startTurnCommand,
} from "./test-support/GroupDeciderFixtures.ts";

const LATER = "2026-08-27T12:00:30.000Z";

const turnId = TurnId.make("turn-boss");

function session(
  status: OrchestrationSession["status"],
  activeTurnId: TurnId | null,
): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-group"),
    status,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId,
    lastError: null,
    updatedAt: NOW,
  };
}

function latestTurn(
  state: OrchestrationLatestTurn["state"],
  completedAt: string | null,
): OrchestrationLatestTurn {
  return {
    turnId,
    state,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt,
    assistantMessageId: null,
    respondingBotId: BOSS_ID,
  };
}

/** A group chat the boss answered last, with the boss's request as its newest user message. */
function bossThread(
  overrides: Pick<OrchestrationThread, "session" | "latestTurn">,
): OrchestrationThread {
  return {
    ...makeGroupThread(),
    respondingBotId: BOSS_ID,
    messages: [
      {
        id: MessageId.make("message-boss"),
        role: "user",
        text: "Please investigate.",
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    ...overrides,
  };
}

function decide(thread: OrchestrationThread, respondingBotId: BotId) {
  return decideOrchestrationCommand({
    command: {
      ...startTurnCommand(respondingBotId),
      message: { ...startTurnCommand().message, messageId: MessageId.make("message-next") },
      createdAt: LATER,
    },
    readModel: makeReadModel({
      bots: [
        makeBot({ id: BOSS_ID, groupId: GROUP_ID }),
        makeBot({ id: SPECIALIST_ID, groupId: GROUP_ID }),
      ],
      groups: [makeGroup()],
      threads: [thread],
    }),
  });
}

function turnStartResponder(result: Effect.Success<ReturnType<typeof decide>>) {
  const event = (Array.isArray(result) ? result : [result]).find(
    (entry) => entry.type === "thread.turn-start-requested",
  );

  return event?.type === "thread.turn-start-requested" ? event.payload.respondingBotId : undefined;
}

it.layer(NodeServices.layer)("group handoff decider", (it) => {
  it.effect.each([
    {
      name: "the boss's turn runs",
      thread: bossThread({
        session: session("running", turnId),
        latestTurn: latestTurn("running", null),
      }),
    },
    {
      // The provider is still admitting the boss's request: the session reports ready and no
      // turn exists for the newest user message yet.
      name: "the boss's turn start has not been picked up",
      thread: bossThread({ session: session("ready", null), latestTurn: null }),
    },
    {
      name: "the boss's session is starting",
      thread: bossThread({ session: session("starting", null), latestTurn: null }),
    },
  ])("refuses a handoff to another bot while $name", ({ thread }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decide(thread, SPECIALIST_ID));

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain(GROUP_HANDOFF_BUSY_MESSAGE);
    }),
  );

  it.effect("accepts a follow-up for the bot whose turn runs", () =>
    Effect.gen(function* () {
      const result = yield* decide(
        bossThread({
          session: session("running", turnId),
          latestTurn: latestTurn("running", null),
        }),
        BOSS_ID,
      );

      expect(turnStartResponder(result)).toBe(BOSS_ID);
    }),
  );

  it.effect("hands the chat to another bot once the boss's turn has finished", () =>
    Effect.gen(function* () {
      const result = yield* decide(
        bossThread({ session: session("ready", null), latestTurn: latestTurn("completed", LATER) }),
        SPECIALIST_ID,
      );

      expect(turnStartResponder(result)).toBe(SPECIALIST_ID);
    }),
  );
});
