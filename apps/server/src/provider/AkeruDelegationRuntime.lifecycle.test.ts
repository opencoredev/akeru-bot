import { describe } from "vite-plus/test";
import { DelegationId, ThreadId, type OrchestrationReadModel } from "@akeru/contracts";
import { expect, it } from "vite-plus/test";
import {
  createAkeruDelegationRuntime,
  type AkeruDelegationChildOutcome,
} from "./AkeruDelegationRuntime.ts";
import { PendingWaiterTimeoutError } from "./PendingWaiters.ts";
import {
  CHILD_BOT_ID,
  CHILD_TURN_ID,
  NOW,
  OTHER_BOT_ID,
  PARENT_BOT_ID,
  PARENT_THREAD_ID,
  PARENT_TURN_ID,
  delegation,
  harness,
  parent,
  request,
  snapshot,
  thread,
} from "./testUtils/delegationHarness.ts";

describe("AkeruDelegationRuntime", () => {
  it("delivers the result with a child link and bills the child bot", async () => {
    const test = harness(
      snapshot({
        threads: [
          thread(PARENT_THREAD_ID, PARENT_BOT_ID, { worktreePath: "/tmp/parent-worktree" }),
          thread(ThreadId.make("child"), CHILD_BOT_ID),
        ],
      }),
      {
        state: "completed",
        turnId: CHILD_TURN_ID,
        summary: "The delegated answer.",
        usage: { inputTokens: 12, outputTokens: 8 },
      },
    );

    const handle = await test.runtime.send(parent(), request() as never);
    expect(handle).toMatchObject({ childBotId: CHILD_BOT_ID, phase: "running" });
    expect(handle.childThreadId).not.toBe(ThreadId.make("child"));
    await test.runtime.drain();
    expect(test.state.delegations.at(-1)?.phase).toMatchObject({
      _tag: "Completed",
      result: { summary: "The delegated answer.", childTurnId: CHILD_TURN_ID },
      acknowledgedAt: null,
    });
    const create = test.commands.find((command) => command.type === "thread.create");
    expect(create).toMatchObject({
      title: "Bot work for bot-child",
      worktreePath: null,
      parentThreadId: PARENT_THREAD_ID,
      parentDelegationId: expect.any(String),
    });
    expect(create && "threadId" in create ? create.threadId : null).not.toBe(PARENT_THREAD_ID);
    const start = test.commands.find((command) => command.type === "thread.turn.start");
    expect(start && "message" in start ? start.message.text : null).toBe(
      [
        "This work was delegated from another bot chat.",
        "Task: Research the answer.",
        "Expected result: A concise answer.",
        "Return a concise final result to the parent chat. Report a concrete blocker or failure.",
      ].join("\n"),
    );
    expect(test.usage).toEqual([
      expect.objectContaining({ botId: CHILD_BOT_ID, category: "delegated", inputTokens: 12 }),
    ]);
    expect(
      test.commands.find(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "delegation.completed",
      ),
    ).toMatchObject({
      threadId: PARENT_THREAD_ID,
      activity: { payload: { childBotId: CHILD_BOT_ID } },
    });
  });

  it("delivers completed work when the usage write fails", async () => {
    const test = harness();
    test.recordUsage.mockRejectedValueOnce(new Error("usage store offline"));
    await test.runtime.send(parent(), request() as never);
    await test.runtime.drain();
    expect(test.state.delegations.map((entry) => entry.phase._tag)).toEqual(["Completed"]);
    expect(
      test.commands.some(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "delegation.completed",
      ),
    ).toBe(true);
  });

  it("keeps lowercase activity kinds and states for delivered phases", async () => {
    const outcomes: ReadonlyArray<[AkeruDelegationChildOutcome, string, string]> = [
      [{ state: "completed", turnId: CHILD_TURN_ID, summary: "Done." }, "completed", "info"],
      [{ state: "blocked", turnId: CHILD_TURN_ID, error: "Access denied." }, "blocked", "info"],
      [{ state: "failed", turnId: CHILD_TURN_ID, error: "Provider failed." }, "failed", "error"],
    ];

    for (const [outcome, state, tone] of outcomes) {
      const test = harness(snapshot(), outcome);
      await test.runtime.send(parent(), request() as never);
      await test.runtime.drain();

      const activities = test.commands.flatMap((command) =>
        command.type === "thread.activity.append" && command.activity.kind.startsWith("delegation.")
          ? [command.activity]
          : [],
      );

      expect(activities.at(-1)).toMatchObject({
        kind: `delegation.${state}`,
        tone,
        payload: { state },
      });
    }
  });

  it("enforces timeout and interrupts the child", async () => {
    const test = harness();

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: async (command) => test.dispatch(command),
      awaitChild: async () => {
        throw new Error("The delegation deadline expired.");
      },
      interruptChild: async (threadId, turnId) => {
        test.interrupts.push({ threadId, turnId });
      },
      now: () => NOW,
      id: (() => {
        let value = 0;

        return () => String(++value);
      })(),
    });

    await runtime.send(parent(), request({ deadline: "2020-01-01T00:00:00.000Z" }) as never);
    await runtime.drain();
    expect(test.state.delegations.at(-1)).toMatchObject({
      phase: { _tag: "Failed", failure: { failureCode: "timeout" } },
    });
    expect(test.interrupts).toHaveLength(1);
  });

  it("treats a waiter timeout without a deadline as a timeout and interrupts the child", async () => {
    const test = harness();

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: async (command) => test.dispatch(command),
      awaitChild: async (childThreadId) => {
        throw new PendingWaiterTimeoutError({
          key: String(childThreadId),
          message: "The bot did not report back within 4 hours.",
        });
      },
      interruptChild: async (threadId, turnId) => {
        test.interrupts.push({ threadId, turnId });
      },
      now: () => NOW,
      id: (() => {
        let value = 0;

        return () => String(++value);
      })(),
    });

    await runtime.send(parent(), request() as never);
    await runtime.drain();
    expect(test.state.delegations.at(-1)).toMatchObject({
      deadline: null,
      phase: {
        _tag: "Failed",
        failure: {
          failureCode: "timeout",
          message: "The bot did not report back within 4 hours.",
        },
      },
    });
    expect(test.interrupts).toHaveLength(1);
  });

  it("still fails and interrupts remaining children when one finishes as the parent fails", async () => {
    let nextId = 0;
    const test = harness();
    const children: Array<PromiseWithResolvers<AkeruDelegationChildOutcome>> = [];
    const watchErrors: unknown[] = [];
    const firstCompleted = Promise.withResolvers<void>();
    let raceArmed = false;

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => {
        const current = test.state;

        if (!raceArmed) return current;
        raceArmed = false;
        // Hand the caller a copy taken while both records were still Running,
        // then let the first child really complete before returning it, so the
        // completion lands between the parent-failure snapshot read and the
        // per-record re-read inside the settlement loop.
        const stale = { ...current, delegations: [...current.delegations] };
        children[0]!.resolve({
          state: "completed",
          turnId: CHILD_TURN_ID,
          summary: "Finished first.",
        });
        await firstCompleted.promise;

        return stale as OrchestrationReadModel;
      },
      dispatch: async (command) => {
        await test.dispatch(command);

        if (test.state.delegations[0]?.phase._tag === "Completed") firstCompleted.resolve();
      },
      awaitChild: () => {
        const child = Promise.withResolvers<AkeruDelegationChildOutcome>();
        children.push(child);

        return child.promise;
      },
      interruptChild: async (threadId, turnId) => {
        test.interrupts.push({ threadId, turnId });
      },
      onWatchError: (_, cause) => watchErrors.push(cause),
      now: () => NOW,
      id: () => String(++nextId),
    });

    await runtime.send(parent(), request() as never);
    await runtime.send(parent(), request({ task: "Second task." }) as never);
    expect(test.state.delegations.map((entry) => entry.phase._tag)).toEqual(["Running", "Running"]);

    raceArmed = true;
    await runtime.parentFinished({
      threadId: PARENT_THREAD_ID,
      turnId: PARENT_TURN_ID,
      failed: true,
    });
    children[1]!.resolve({ state: "failed", turnId: CHILD_TURN_ID, error: "Interrupted." });
    await runtime.drain();

    // The first child finished between the snapshot read and its settlement
    // write; it must stay Completed. The second must still be failed and
    // interrupted, and it is the only interrupt sent.
    expect(test.state.delegations[0]?.phase._tag).toBe("Completed");
    expect(test.state.delegations[1]?.phase).toMatchObject({
      _tag: "Failed",
      failure: { failureCode: "parent_failed" },
    });
    expect(test.interrupts).toHaveLength(1);
    expect(watchErrors).toEqual([]);
  });

  it("returns a handle while the child runs and records the result when it finishes", async () => {
    const test = harness();
    const child = Promise.withResolvers<AkeruDelegationChildOutcome>();
    const watchErrors: unknown[] = [];

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: test.dispatch,
      awaitChild: () => child.promise,
      interruptChild: async () => undefined,
      onWatchError: (_, cause) => watchErrors.push(cause),
      now: () => NOW,
      id: (() => {
        let value = 0;

        return () => String(++value);
      })(),
    });

    const handle = await runtime.send(parent(), request() as never);
    expect(handle).toEqual({
      delegationId: test.state.delegations[0]!.delegationId,
      childThreadId: expect.any(String),
      childBotId: CHILD_BOT_ID,
      name: CHILD_BOT_ID,
      phase: "running",
    });
    expect(test.state.delegations[0]?.phase._tag).toBe("Running");

    // The parent turn has ended; the result still lands on the parent chat.
    child.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Late answer." });
    await runtime.drain();
    expect(test.state.delegations[0]?.phase).toMatchObject({
      _tag: "Completed",
      result: { summary: "Late answer." },
      acknowledgedAt: null,
    });
    expect(
      test.commands.flatMap((command) =>
        command.type === "thread.activity.append" ? [command.activity.kind] : [],
      ),
    ).toEqual(["delegation.running", "delegation.completed"]);
    expect(watchErrors).toEqual([]);
  });

  it("acknowledges a finished result that CheckAgent returns", async () => {
    const test = harness();
    await test.runtime.send(parent(), request() as never);
    await test.runtime.drain();

    await expect(test.runtime.check(parent(), { botId: CHILD_BOT_ID })).resolves.toMatchObject({
      delegations: [{ state: "completed", summary: "The delegated answer." }],
    });
    expect(test.state.delegations[0]?.phase).toMatchObject({
      _tag: "Completed",
      acknowledgedAt: NOW,
    });

    const writes = test.commands.length;
    await expect(test.runtime.check(parent(), { botId: CHILD_BOT_ID })).resolves.toMatchObject({
      delegations: [{ state: "completed", summary: "The delegated answer." }],
    });
    expect(test.commands).toHaveLength(writes);
  });

  it("leaves another parent bot's pending result for that bot", async () => {
    const childThreadId = ThreadId.make("other-parent-child");

    const otherResult = delegation(DelegationId.make("other-parent-delegation"), {
      parentBotId: OTHER_BOT_ID,
      phase: {
        _tag: "Completed",
        childThreadId,
        childTurnId: CHILD_TURN_ID,
        startedAt: NOW,
        completedAt: NOW,
        result: { summary: "Other bot's answer.", childThreadId, childTurnId: CHILD_TURN_ID },
        acknowledgedAt: null,
      },
    });

    const test = harness(snapshot({ delegations: [otherResult] }));

    await expect(test.runtime.check(parent(), { botId: CHILD_BOT_ID })).resolves.toMatchObject({
      delegations: [],
    });
    expect(test.state.delegations[0]?.phase).toMatchObject({ acknowledgedAt: null });
  });

  it("waits for the child before its turn starts", async () => {
    const test = harness();
    const order: string[] = [];

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: async (command) => {
        if (command.type === "thread.turn.start") order.push("turn.start");
        await test.dispatch(command);
      },
      awaitChild: async () => {
        order.push("awaitChild");

        return { state: "completed", turnId: CHILD_TURN_ID, summary: "Fast answer." };
      },
      interruptChild: async () => undefined,
      now: () => NOW,
      id: (() => {
        let value = 0;

        return () => String(++value);
      })(),
    });

    await runtime.send(parent(), request() as never);
    await runtime.drain();

    expect(order).toEqual(["awaitChild", "turn.start"]);
    expect(test.state.delegations[0]?.phase._tag).toBe("Completed");
  });
});
