// @effect-diagnostics nodeBuiltinImport:off
import {
  BotId,
  DelegationId,
  GroupId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
import { type AkeruDelegationChildOutcome } from "./AkeruDelegationRuntime.ts";
import {
  CHILD_BOT_ID,
  CHILD_TURN_ID,
  NOW,
  OTHER_BOT_ID,
  PARENT_BOT_ID,
  PARENT_THREAD_ID,
  bot,
  harness,
  parent,
  request,
  snapshot,
  thread,
} from "./testUtils/delegationHarness.ts";

describe("AkeruDelegationRuntime", () => {
  it("runs group work in a direct child chat and posts the attributed result to the group", async () => {
    const groupId = GroupId.make("group-1");
    const group = {
      id: groupId,
      name: "Research",
      bossBotId: PARENT_BOT_ID,
      members: [
        { kind: "bot" as const, botId: PARENT_BOT_ID, role: "boss" as const },
        { kind: "bot" as const, botId: CHILD_BOT_ID, role: "specialist" as const },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const grouped = snapshot({
      bots: [
        bot(PARENT_BOT_ID, { groupId, name: "Boss" }),
        bot(CHILD_BOT_ID, { groupId, name: "Scout" }),
      ],
      groups: [group],
      threads: [thread(PARENT_THREAD_ID, null, { groupId, respondingBotId: PARENT_BOT_ID })],
    });
    const test = harness(grouped);
    const handle = await test.runtime.send(parent(), request() as never);
    await test.runtime.drain();

    const create = test.commands.find((command) => command.type === "thread.create");
    expect(create).toMatchObject({ botId: CHILD_BOT_ID, groupId: null });
    const childTurn = test.commands.find((command) => command.type === "thread.turn.start");
    expect(childTurn).not.toHaveProperty("respondingBotId");
    expect(childTurn && "threadId" in childTurn ? childTurn.threadId : null).toBe(
      handle.childThreadId,
    );

    const groupThread = test.state.threads.find((entry) => entry.id === PARENT_THREAD_ID);
    const posted = groupThread?.messages.filter((message) => message.role === "assistant");
    expect(posted).toEqual([
      expect.objectContaining({
        text: "Finished work for Boss: Research the answer.\n\nThe delegated answer.",
        respondingBotId: CHILD_BOT_ID,
        turnId: null,
        streaming: false,
      }),
    ]);
    // A server-authored message starts no turn in the group.
    expect(
      test.commands.filter(
        (command) => command.type === "thread.turn.start" && command.threadId === PARENT_THREAD_ID,
      ),
    ).toEqual([]);
  });

  describe("group result after the child finishes", () => {
    const groupId = GroupId.make("group-1");
    const grouped = () =>
      snapshot({
        bots: [
          bot(PARENT_BOT_ID, { groupId, name: "Boss" }),
          bot(CHILD_BOT_ID, { groupId, name: "Scout" }),
        ],
        groups: [
          {
            id: groupId,
            name: "Research",
            bossBotId: PARENT_BOT_ID,
            members: [
              { kind: "bot" as const, botId: PARENT_BOT_ID, role: "boss" as const },
              { kind: "bot" as const, botId: CHILD_BOT_ID, role: "specialist" as const },
            ],
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        threads: [thread(PARENT_THREAD_ID, null, { groupId, respondingBotId: PARENT_BOT_ID })],
      });
    const removeChildFromGroup = (state: OrchestrationReadModel) => {
      Object.assign(state, {
        groups: state.groups.map((group) => ({
          ...group,
          members: group.members.filter(
            (member) => !("botId" in member) || member.botId !== CHILD_BOT_ID,
          ),
        })),
      });
    };
    const groupMessages = (state: OrchestrationReadModel) =>
      state.threads
        .find((entry) => entry.id === PARENT_THREAD_ID)
        ?.messages.filter((message) => message.role === "assistant");

    it("skips the group message when the bot left the group mid-task", async () => {
      const child = Promise.withResolvers<AkeruDelegationChildOutcome>();
      const skipped: Array<[DelegationId, string]> = [];
      const watchErrors: unknown[] = [];
      const test = harness(grouped(), undefined, {
        awaitChild: () => child.promise,
        onGroupResultSkipped: (delegationId, reason) => skipped.push([delegationId, reason]),
        onWatchError: (_, cause) => watchErrors.push(cause),
      });
      const handle = await test.runtime.send(parent(), request() as never);
      removeChildFromGroup(test.state);
      child.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Done." });
      await test.runtime.drain();

      expect(test.state.delegations[0]?.phase._tag).toBe("Completed");
      expect(groupMessages(test.state)).toEqual([]);
      expect(skipped).toEqual([[handle.delegationId, "bot_left_group"]]);
      expect(watchErrors).toEqual([]);
    });

    it("reports a decider refusal from a bot that left during the post as a skip", async () => {
      const skipped: string[] = [];
      const watchErrors: unknown[] = [];
      let inner: ((command: OrchestrationCommand) => Promise<void>) | undefined;
      const test = harness(grouped(), undefined, {
        dispatch: async (command) => {
          if (command.type === "thread.message.assistant.delta") removeChildFromGroup(test.state);
          await inner?.(command);
        },
        onGroupResultSkipped: (_, reason) => skipped.push(reason),
        onWatchError: (_, cause) => watchErrors.push(cause),
      });
      inner = test.dispatch;
      await test.runtime.send(parent(), request() as never);
      await test.runtime.drain();

      expect(test.state.delegations[0]?.phase._tag).toBe("Completed");
      expect(groupMessages(test.state)).toEqual([]);
      expect(skipped).toEqual(["bot_left_group"]);
      expect(watchErrors).toEqual([]);
    });

    it("names the parent bot as it is when the work finishes", async () => {
      const child = Promise.withResolvers<AkeruDelegationChildOutcome>();
      const test = harness(grouped(), undefined, { awaitChild: () => child.promise });
      await test.runtime.send(parent(), request() as never);
      Object.assign(test.state, {
        bots: test.state.bots.map((entry) =>
          entry.id === PARENT_BOT_ID ? { ...entry, name: "Chief" } : entry,
        ),
      });
      child.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Done." });
      await test.runtime.drain();

      expect(groupMessages(test.state)?.map((message) => message.text)).toEqual([
        "Finished work for Chief: Research the answer.\n\nDone.",
      ]);
    });
  });

  it("does not post a group message for work sent from a direct chat", async () => {
    const test = harness();
    await test.runtime.send(parent(), request() as never);
    await test.runtime.drain();
    const parentThread = test.state.threads.find((entry) => entry.id === PARENT_THREAD_ID);
    expect(parentThread?.messages.filter((message) => message.role === "assistant")).toEqual([]);
  });

  it("delegates to a bot in two groups from either group and from a direct chat", async () => {
    const firstGroupId = GroupId.make("group-1");
    const secondGroupId = GroupId.make("group-2");
    const groupOf = (id: GroupId, boss: BotId) => ({
      id,
      name: String(id),
      bossBotId: boss,
      members: [
        { kind: "bot" as const, botId: boss, role: "boss" as const },
        { kind: "bot" as const, botId: CHILD_BOT_ID, role: "specialist" as const },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const secondThreadId = ThreadId.make("thread-second-group");
    const test = harness(
      snapshot({
        // The legacy exclusive field names only the first group.
        bots: [bot(PARENT_BOT_ID), bot(OTHER_BOT_ID), bot(CHILD_BOT_ID, { groupId: firstGroupId })],
        groups: [groupOf(firstGroupId, PARENT_BOT_ID), groupOf(secondGroupId, OTHER_BOT_ID)],
        threads: [
          thread(PARENT_THREAD_ID, null, {
            groupId: firstGroupId,
            respondingBotId: PARENT_BOT_ID,
          }),
          thread(secondThreadId, null, { groupId: secondGroupId, respondingBotId: OTHER_BOT_ID }),
          thread(ThreadId.make("thread-direct"), OTHER_BOT_ID),
        ],
      }),
    );
    await test.runtime.send(parent(), request() as never);
    await test.runtime.send(
      parent({ threadId: secondThreadId, botId: OTHER_BOT_ID }),
      request() as never,
    );
    await test.runtime.send(
      parent({ threadId: ThreadId.make("thread-direct"), botId: OTHER_BOT_ID }),
      request() as never,
    );
    await test.runtime.drain();
    expect(test.state.delegations.map((entry) => [entry.parentThreadId, entry.phase._tag])).toEqual(
      [
        [PARENT_THREAD_ID, "Completed"],
        [secondThreadId, "Completed"],
        [ThreadId.make("thread-direct"), "Completed"],
      ],
    );
    expect(
      test.state.threads
        .find((entry) => entry.id === secondThreadId)
        ?.messages.map((message) => message.respondingBotId),
    ).toEqual([CHILD_BOT_ID]);
  });

  it("requires authoritative group membership for an associated bot", async () => {
    const groupId = GroupId.make("group-1");
    const group = {
      id: groupId,
      name: "Research",
      bossBotId: PARENT_BOT_ID,
      members: [{ kind: "bot" as const, botId: PARENT_BOT_ID, role: "boss" as const }],
      createdAt: NOW,
      updatedAt: NOW,
    };

    await expect(
      harness(
        snapshot({
          bots: [bot(PARENT_BOT_ID, { groupId }), bot(CHILD_BOT_ID, { groupId })],
          groups: [group],
          threads: [
            thread(PARENT_THREAD_ID, null, {
              groupId,
              respondingBotId: PARENT_BOT_ID,
            }),
          ],
        }),
      ).runtime.send(parent(), request() as never),
    ).rejects.toThrow("The target bot is not available in the current group.");
  });
});
