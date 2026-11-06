import {
  AuthSessionId,
  BotId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  GroupId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type BotSandboxBrowserSharing,
  type OrchestrationSession,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { afterEach, assert, describe, expect, it } from "vite-plus/test";

import { GROUP_HANDOFF_BUSY_MESSAGE } from "../groupResponder.ts";
import {
  asMessageId,
  createProviderCommandHarness,
} from "./test-support/ProviderCommandHarness.ts";

type Harness = Awaited<
  ReturnType<ReturnType<typeof createProviderCommandHarness>["createHarness"]>
>;

const threadId = ThreadId.make("thread-group");

const bossTurnId = TurnId.make("turn-boss");

const now = "2026-01-01T00:00:00.000Z";

describe("ProviderCommandReactor group handoff", () => {
  const testScope = createProviderCommandHarness();

  afterEach(testScope.dispose);

  it("reconfigures the session for the bot a group hands the chat to", async () => {
    const harness = await createGroupHarness("shared");

    await runBossTurn(harness);
    await setSession(harness, "ready", null);
    await sendGroupTurn(harness, "specialist", "bot-2");
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    expect(sessionBots(harness)).toEqual(["bot-1", "bot-2"]);
  });

  it.each<BotSandboxBrowserSharing>(["separate", "shared"])(
    "refuses a handoff while the previous bot's turn runs, with %s workspaces",
    async (sharing) => {
      const harness = await createGroupHarness(sharing);

      await runBossTurn(harness);

      const refused = await harness.runEffect(
        Effect.flip(dispatchGroupTurn(harness, "specialist", "bot-2")),
      );

      expect(refused.message).toContain(GROUP_HANDOFF_BUSY_MESSAGE);
      await harness.drain();

      // The boss keeps the chat, and nothing was saved or queued for the specialist.
      const thread = await readThread(harness);
      expect(thread?.respondingBotId).toBe("bot-1");
      expect(thread?.messages.map((message) => message.id)).not.toContain(
        asMessageId("message-specialist"),
      );
      expect(thread?.session?.status).toBe("running");

      // The boss's continuing output stays the boss's.
      await harness.runEffect(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("cmd-boss-reply"),
          threadId,
          messageId: asMessageId("message-boss-reply"),
          delta: "Still checking.",
          turnId: bossTurnId,
          createdAt: now,
        }),
      );

      expect(
        (await readThread(harness))?.messages.find(
          (message) => message.id === asMessageId("message-boss-reply"),
        )?.respondingBotId,
      ).toBe("bot-1");

      // A restarted server has nothing to replay for the specialist.
      await setSession(harness, "ready", null);
      await restartReactor(harness);
      expect(sessionBots(harness)).toEqual(["bot-1"]);
      expect(harness.sendTurn).toHaveBeenCalledOnce();

      // Once the boss finishes, the specialist's next message reconfigures and runs.
      await sendGroupTurn(harness, "specialist-retry", "bot-2");
      await harness.waitFor(() => harness.sendTurn.mock.calls.length === 2);
      await harness.drain();

      expect(sessionBots(harness)).toEqual(["bot-1", "bot-2"]);
    },
  );

  it("refuses a handoff in the reactor while the provider still admits the previous bot's turn", async () => {
    const harness = await createGroupHarness("separate");

    await runBossTurn(harness);
    await setSession(harness, "ready", null);

    // The chat looks idle, but the provider has already taken another turn for the boss.
    const sessionIndex = harness.runtimeSessions.findIndex(
      (session) => session.threadId === threadId,
    );

    const bossSession = harness.runtimeSessions[sessionIndex];
    assert.isDefined(bossSession);
    harness.runtimeSessions[sessionIndex] = {
      ...bossSession,
      activeTurnId: TurnId.make("turn-boss-admitting"),
    };

    await sendGroupTurn(harness, "specialist", "bot-2");
    await harness.drain();

    const thread = await readThread(harness);
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed")
        ?.payload,
    ).toMatchObject({ detail: GROUP_HANDOFF_BUSY_MESSAGE, requestId: "message-specialist" });
    // The refusal leaves the boss's session as it was.
    expect(thread?.session?.status).toBe("ready");
    expect(thread?.session?.lastError ?? null).toBeNull();

    // The refused request is settled, so a restarted server does not run it.
    harness.runtimeSessions[sessionIndex] = bossSession;
    await restartReactor(harness);
    expect(sessionBots(harness)).toEqual(["bot-1"]);
    expect(harness.sendTurn).toHaveBeenCalledOnce();
  });

  /** The boss answers the chat's first message, and its turn is running. */
  async function runBossTurn(harness: Harness) {
    await sendGroupTurn(harness, "boss", "bot-1");
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    await setSession(harness, "running", bossTurnId);
  }

  function setSession(
    harness: Harness,
    status: OrchestrationSession["status"],
    activeTurnId: TurnId | null,
  ) {
    return harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-session-${status}`),
        threadId,
        session: {
          threadId,
          status,
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          mcpServerIds: [],
          activeTurnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
  }

  /** Starts a second reactor over the same state, as a server restart would, and stops it. */
  async function restartReactor(harness: Harness) {
    const reactorScope = await harness.runEffect(Scope.make("sequential"));

    try {
      const reactor = await harness.startReactor(reactorScope);
      await harness.runEffect(reactor.drain);
    } finally {
      await harness.runEffect(Scope.close(reactorScope, Exit.void));
    }
  }

  async function readThread(harness: Harness) {
    return (await harness.readModel()).threads.find((entry) => entry.id === threadId);
  }

  function dispatchGroupTurn(harness: Harness, id: string, respondingBotId: string) {
    return harness.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`cmd-turn-${id}`),
      threadId,
      message: {
        messageId: asMessageId(`message-${id}`),
        role: "user",
        text: `turn ${id}`,
        attachments: [],
      },
      respondingBotId: BotId.make(respondingBotId),
      senderPersonId: AuthSessionId.make("session-owner"),
      senderCanManageGroups: true,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt: now,
    });
  }

  function sendGroupTurn(harness: Harness, id: string, respondingBotId: string) {
    return harness.runEffect(dispatchGroupTurn(harness, id, respondingBotId));
  }

  /** The bot each provider session for the group chat was started or reconfigured for. */
  function sessionBots(harness: Harness) {
    return harness.startSession.mock.calls
      .filter((call) => call[1].threadId === threadId)
      .map((call) => call[1].botId);
  }

  /**
   * Two bots on the same engine in one group and a group chat with no session yet. With shared
   * workspaces, only the responding bot changes between turns.
   */
  async function createGroupHarness(botSandboxBrowserSharing: BotSandboxBrowserSharing) {
    const harness = await testScope.createHarness({
      botEngine: { provider: "codex", model: "gpt-5.6-sol" },
      secondBot: { engine: { provider: "codex", model: "gpt-5.6-sol" } },
      botSandboxBrowserSharing,
    });

    await harness.runEffect(
      harness.engine.dispatch({
        type: "group.create",
        commandId: CommandId.make("cmd-group-create"),
        groupId: GroupId.make("group-1"),
        name: "Product",
        bossBotId: BotId.make("bot-1"),
        specialistBotIds: [BotId.make("bot-2")],
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-group"),
        threadId,
        projectId: ProjectId.make("project-1"),
        groupId: GroupId.make("group-1"),
        title: "Group chat",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return harness;
  }
});
