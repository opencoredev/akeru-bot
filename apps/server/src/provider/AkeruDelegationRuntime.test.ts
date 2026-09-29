import {
  AKERU_DELEGATION_CONTEXT_MAX_CHARS,
  AkeruDelegationContextTooLongError,
  AkeruDelegationProviderUnsupportedError,
  BotId,
  CommandId,
  DelegationId,
  GroupId,
  McpServerId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  AkeruDelegationRecord,
  AkeruToolInputSchemas,
  type AkeruDelegationAccessGrant,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  createAkeruDelegationRuntime,
  type AkeruDelegationChildOutcome,
} from "./AkeruDelegationRuntime.ts";
import { PendingWaiterTimeoutError } from "./PendingWaiters.ts";
import { intersectDelegationAccess } from "./AkeruToolRuntime.ts";
import {
  CHILD_BOT_ID,
  CHILD_TURN_ID,
  NOW,
  OTHER_BOT_ID,
  PARENT_BOT_ID,
  PARENT_THREAD_ID,
  PARENT_TURN_ID,
  access,
  bot,
  delegation,
  harness,
  parent,
  request,
  snapshot,
  thread,
} from "./testUtils/delegationHarness.ts";

describe("delegation access", () => {
  it("intersects MCP disables, user-computer capability, tools, and memory scopes", () => {
    const grant = intersectDelegationAccess({
      parent: access({
        allowedToolIds: ["Read", "ExternalRead", "SendToAgent"],
        memoryScopes: ["private", "project"],
        hasUserComputer: false,
        enabledMcpServerIds: [McpServerId.make("web"), McpServerId.make("email")],
        disabledMcpServerIds: [McpServerId.make("parent-disabled")],
      }),
      child: access({
        allowedToolIds: ["Read", "ExternalRead"],
        memoryScopes: ["project", "group"],
        hasUserComputer: true,
        enabledMcpServerIds: [McpServerId.make("web")],
        disabledMcpServerIds: [McpServerId.make("child-disabled")],
      }),
      requested: request({
        allowedToolIds: ["Read", "ExternalRead"],
        memoryScopes: ["project"],
        mcpServerIds: [McpServerId.make("web"), McpServerId.make("email")],
      }) as never,
    });
    expect(grant).toMatchObject({
      allowedToolIds: ["Read", "ExternalRead"],
      memoryScopes: ["project"],
      hasUserComputer: false,
      enabledMcpServerIds: ["web"],
      disabledMcpServerIds: ["parent-disabled", "child-disabled"],
    });
  });

  it("rejects extra memory, tools, full access, and approval upgrades", () => {
    for (const requested of [
      { memoryScopes: ["workspace"] },
      { allowedToolIds: ["ExternalShell"] },
      { runtimeMode: "full-access" },
      { approvalCeiling: "production" },
    ]) {
      expect(() =>
        intersectDelegationAccess({
          parent: access(),
          child: access({ runtimeMode: "full-access", approvalCeiling: "secrets" }),
          requested: request(requested) as never,
        }),
      ).toThrow("parent turn grant");
    }
  });

  it("allows a delegation to remove sandbox access", () => {
    expect(
      intersectDelegationAccess({
        parent: access({ sandbox: "local" }),
        child: access({ sandbox: "local" }),
        requested: request({ sandbox: null }) as never,
      }).sandbox,
    ).toBeNull();
  });
});

describe("AkeruDelegationRuntime", () => {
  it("sends a bot message through its active thread", async () => {
    const test = harness(
      snapshot({
        threads: [
          thread(PARENT_THREAD_ID, PARENT_BOT_ID, {
            latestTurn: {
              turnId: PARENT_TURN_ID,
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        ],
      }),
    );

    await expect(
      test.runtime.sendToUser(parent(), { message: "The export is ready." }),
    ).resolves.toMatchObject({
      toolId: "SendToUser",
      phase: "success",
      threadId: PARENT_THREAD_ID,
      botId: PARENT_BOT_ID,
    });
    expect(test.commands.slice(-2)).toMatchObject([
      {
        type: "thread.message.assistant.delta",
        threadId: PARENT_THREAD_ID,
        turnId: PARENT_TURN_ID,
        delta: "The export is ready.",
      },
      {
        type: "thread.message.assistant.complete",
        threadId: PARENT_THREAD_ID,
        turnId: PARENT_TURN_ID,
      },
    ]);
  });

  it("rejects user messages from a bot that does not own the active thread", async () => {
    const test = harness(
      snapshot({
        threads: [
          thread(PARENT_THREAD_ID, PARENT_BOT_ID, {
            latestTurn: {
              turnId: PARENT_TURN_ID,
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        ],
      }),
    );

    await expect(
      test.runtime.sendToUser(parent({ botId: OTHER_BOT_ID }), { message: "Wrong thread." }),
    ).rejects.toThrow("not authorized");
  });

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

  it("persists a completed record that decodes with the child turn", async () => {
    const test = harness();
    await test.runtime.send(parent(), request() as never);
    await test.runtime.drain();

    const persisted = test.state.delegations.at(-1);
    const encoded = Schema.encodeUnknownSync(AkeruDelegationRecord)(persisted);
    const decoded = Schema.decodeUnknownSync(AkeruDelegationRecord)(encoded);
    expect(decoded.phase).toMatchObject({
      _tag: "Completed",
      childTurnId: CHILD_TURN_ID,
      result: { summary: "The delegated answer.", childTurnId: CHILD_TURN_ID },
    });
  });

  it("anchors the record on the parent turn's user message", async () => {
    const latestTurn = (turnId: TurnId) => ({
      turnId,
      state: "running" as const,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
      requestMessageId: MessageId.make("message-user"),
    });
    const anchored = harness(
      snapshot({
        threads: [
          thread(PARENT_THREAD_ID, PARENT_BOT_ID, { latestTurn: latestTurn(PARENT_TURN_ID) }),
        ],
      }),
    );
    await anchored.runtime.send(parent(), request() as never);
    expect(anchored.state.delegations.at(-1)).toMatchObject({
      anchorMessageId: "message-user",
      retryOfDelegationId: null,
      trigger: "bot",
    });

    const otherTurn = harness(
      snapshot({
        threads: [
          thread(PARENT_THREAD_ID, PARENT_BOT_ID, {
            latestTurn: latestTurn(TurnId.make("turn-other")),
          }),
        ],
      }),
    );
    await otherTurn.runtime.send(parent(), request() as never);
    expect(otherTurn.state.delegations.at(-1)?.anchorMessageId).toBeNull();
  });

  it("keeps work a bot sent with keep running after its turn ends", async () => {
    const test = harness();
    const child = Promise.withResolvers<AkeruDelegationChildOutcome>();
    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: test.dispatch,
      awaitChild: () => child.promise,
      interruptChild: async () => undefined,
      now: () => NOW,
      id: (() => {
        let next = 100;
        return () => String(++next);
      })(),
    });
    const input = Schema.decodeUnknownSync(AkeruToolInputSchemas.SendToAgent)(
      request({ keep: true }),
    );
    const handle = await runtime.send(parent(), input);
    expect(test.state.delegations.at(-1)).toMatchObject({ keep: true });

    await runtime.parentFinished({
      threadId: PARENT_THREAD_ID,
      turnId: PARENT_TURN_ID,
      failed: false,
    });
    expect(test.state.delegations.at(-1)?.phase._tag).toBe("Running");

    child.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Done later." });
    await runtime.drain();
    expect(test.state.delegations.at(-1)).toMatchObject({
      delegationId: handle.delegationId,
      phase: { _tag: "Completed", result: { summary: "Done later." } },
    });
  });

  it("retries failed work as a new record and never changes the original", async () => {
    const original = delegation(DelegationId.make("delegation-original"), {
      anchorMessageId: MessageId.make("message-user"),
      access: access({ memoryScopes: ["project"], allowedToolIds: ["Read"] }),
      phase: {
        _tag: "Failed",
        childThreadId: ThreadId.make("child-old"),
        childTurnId: CHILD_TURN_ID,
        startedAt: NOW,
        completedAt: NOW,
        failure: { failureCode: "child_failed", message: "The child failed." },
        acknowledgedAt: null,
      },
    });
    const test = harness(snapshot({ delegations: [original] }));

    const handle = await test.runtime.dispatchDelegation({
      _tag: "Retry",
      delegationId: original.delegationId,
    });
    await test.runtime.drain();

    expect(test.state.delegations[0]).toEqual(original);
    expect(
      test.commands.filter(
        (command) =>
          (command.type === "delegation.state.set" || command.type === "delegation.create") &&
          command.delegation.delegationId === original.delegationId,
      ),
    ).toEqual([]);
    const retried = test.state.delegations.find(
      (entry) => entry.delegationId === handle.delegationId,
    );
    expect(retried).toMatchObject({
      retryOfDelegationId: original.delegationId,
      anchorMessageId: "message-user",
      trigger: "bot",
      parentBotId: PARENT_BOT_ID,
      childBotId: CHILD_BOT_ID,
      parentTurnId: PARENT_TURN_ID,
      ancestorBotIds: [PARENT_BOT_ID],
      depth: 1,
      task: original.task,
      access: original.access,
      phase: { _tag: "Completed" },
    });

    await expect(
      test.runtime.dispatchDelegation({ _tag: "Retry", delegationId: handle.delegationId }),
    ).rejects.toThrow("Only failed or canceled bot work can be retried.");
  });

  it("starts scheduled work from the owner chat that its turn end leaves running", async () => {
    const test = harness(
      snapshot({
        threads: [
          thread(PARENT_THREAD_ID, PARENT_BOT_ID, {
            latestTurn: {
              turnId: PARENT_TURN_ID,
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
              requestMessageId: MessageId.make("message-user"),
            },
            messages: [
              {
                id: MessageId.make("message-last"),
                role: "assistant",
                text: "Earlier reply.",
                turnId: PARENT_TURN_ID,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );
    const child = Promise.withResolvers<AkeruDelegationChildOutcome>();
    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: test.dispatch,
      awaitChild: () => child.promise,
      interruptChild: async () => undefined,
      now: () => NOW,
      id: (() => {
        let next = 200;
        return () => String(++next);
      })(),
    });

    await runtime.dispatchDelegation({
      _tag: "Scheduled",
      parentThreadId: PARENT_THREAD_ID,
      parentBotId: PARENT_BOT_ID,
      childBotId: CHILD_BOT_ID,
      task: "Summarize the inbox.",
      expectedResult: "Three bullet points.",
      runtimeMode: "approval-required",
    });
    expect(test.state.delegations.at(-1)).toMatchObject({
      trigger: "scheduled",
      retryOfDelegationId: null,
      anchorMessageId: "message-last",
      parentBotId: PARENT_BOT_ID,
      parentDelegationId: null,
      depth: 1,
      access: { memoryScopes: [], runtimeMode: "approval-required" },
    });
    // The card keeps its own turn, so the running chat turn cannot move it.
    expect(test.state.delegations.at(-1)?.parentTurnId).not.toBe(PARENT_TURN_ID);

    await runtime.parentFinished({
      threadId: PARENT_THREAD_ID,
      turnId: PARENT_TURN_ID,
      failed: true,
    });
    expect(test.state.delegations.at(-1)?.phase._tag).toBe("Running");

    child.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Inbox summary." });
    await runtime.drain();
    expect(test.state.delegations.at(-1)?.phase._tag).toBe("Completed");
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

  it("rejects A to B to A cycles, depth, and concurrency caps", async () => {
    await expect(
      harness().runtime.send(
        parent({ botId: CHILD_BOT_ID, ancestorBotIds: [PARENT_BOT_ID] }),
        request({ botId: PARENT_BOT_ID }) as never,
      ),
    ).rejects.toThrow("cycle");
    await expect(harness().runtime.send(parent({ depth: 2 }), request() as never)).rejects.toThrow(
      "depth",
    );
    const active = [1, 2, 3].map((index) => delegation(DelegationId.make(`active-${index}`)));
    await expect(
      harness(snapshot({ delegations: active })).runtime.send(parent(), request() as never),
    ).rejects.toThrow("more than 3");
  });

  it("deletes the child thread when authoritative delegation admission fails", async () => {
    const commands: OrchestrationCommand[] = [];
    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => snapshot(),
      dispatch: async (command) => {
        commands.push(command);
        if (command.type === "delegation.create") throw new Error("Delegation limit reached.");
      },
      awaitChild: async () => ({ state: "completed", turnId: CHILD_TURN_ID, summary: "Done." }),
      interruptChild: async () => undefined,
      now: () => NOW,
      id: () => String(commands.length + 1),
    });

    await expect(runtime.send(parent(), request() as never)).rejects.toThrow(
      "Delegation limit reached.",
    );
    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "delegation.create",
      "thread.delete",
    ]);
  });

  it("grants only the memory scopes the parent holds and the request names", async () => {
    const scoped = harness();
    await scoped.runtime.send(parent(), request({ memoryScopes: ["project"] }) as never);
    expect(scoped.state.delegations.at(-1)?.access.memoryScopes).toEqual(["project"]);

    const omitted = harness();
    await omitted.runtime.send(parent(), request() as never);
    expect(omitted.state.delegations.at(-1)?.access.memoryScopes).toEqual([]);

    await expect(
      harness().runtime.send(parent(), request({ memoryScopes: ["group"] }) as never),
    ).rejects.toThrow("parent turn grant");
  });

  it("hands bounded parent context to the child and rejects oversized context", async () => {
    const test = harness();
    await test.runtime.send(
      parent(),
      request({ context: "The user prefers metric units." }) as never,
    );
    const start = test.commands.find((command) => command.type === "thread.turn.start");
    expect(start && "message" in start ? start.message.text : null).toContain(
      "Context from the parent bot:\nThe user prefers metric units.",
    );

    const oversized = "x".repeat(AKERU_DELEGATION_CONTEXT_MAX_CHARS + 1);
    const rejected = harness();
    await expect(
      rejected.runtime.send(parent(), request({ context: oversized }) as never),
    ).rejects.toBeInstanceOf(AkeruDelegationContextTooLongError);
    expect(rejected.commands).toEqual([]);
  });

  it("preserves blocked state and persists child failure", async () => {
    const blocked = harness(snapshot(), {
      state: "blocked",
      turnId: CHILD_TURN_ID,
      error: "Access denied.",
    });
    await blocked.runtime.send(parent(), request() as never);
    await blocked.runtime.drain();
    expect(blocked.state.delegations.at(-1)).toMatchObject({
      phase: { _tag: "Blocked", reason: "Access denied." },
      billedBotId: CHILD_BOT_ID,
    });

    const failed = harness(snapshot(), {
      state: "failed",
      turnId: CHILD_TURN_ID,
      error: "Provider failed.",
    });
    await failed.runtime.send(parent(), request() as never);
    await failed.runtime.drain();
    expect(failed.state.delegations.at(-1)).toMatchObject({
      phase: { _tag: "Failed", failure: { failureCode: "child_failed" }, acknowledgedAt: null },
      billedBotId: CHILD_BOT_ID,
    });
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

  it("cancels children on parent interrupt, preserves kept children, and marks parent failure", async () => {
    const checks = async (mode: "cancel" | "keep" | "fail") => {
      let release!: (outcome: AkeruDelegationChildOutcome) => void;
      let nextId = 0;
      const started = Promise.withResolvers<void>();
      const test = harness();
      const runtime = createAkeruDelegationRuntime({
        readSnapshot: async () => test.state,
        dispatch: async (command) => {
          await test.dispatch(command);
        },
        awaitChild: (childThread) =>
          new Promise<AkeruDelegationChildOutcome>((resolve) => {
            release = (outcome) => {
              // Model the provider reactor: when the child ends on a turn, the
              // turn id lands on the record before the outcome is reported.
              const assignTurn =
                outcome.turnId === null
                  ? Promise.resolve()
                  : test
                      .dispatch({
                        type: "delegation.state.set",
                        commandId: CommandId.make(`test:assign-turn:${++nextId}`),
                        delegation: {
                          ...test.state.delegations.find(
                            (entry) =>
                              entry.phase._tag !== "Queued" &&
                              entry.phase.childThreadId === childThread,
                          )!,
                          phase: {
                            _tag: "Running",
                            childThreadId: childThread,
                            childTurnId: outcome.turnId,
                            startedAt: NOW,
                            progress: null,
                          },
                        },
                      })
                      .catch(() => undefined);
              void assignTurn.then(() => resolve(outcome));
            };
            started.resolve();
          }),
        interruptChild: async (threadId, turnId) => {
          test.interrupts.push({ threadId, turnId });
          release({ state: "failed", turnId, error: "Interrupted." });
        },
        now: () => NOW,
        id: () => String(++nextId),
      });
      await runtime.send(parent(), request() as never);
      await started.promise;
      const id = test.state.delegations[0]!.delegationId;
      await runtime.parentFinished({
        threadId: PARENT_THREAD_ID,
        turnId: PARENT_TURN_ID,
        failed: mode === "fail",
        ...(mode === "keep" ? { keep: new Set([id]) } : {}),
      });
      if (mode === "keep") {
        expect(test.interrupts).toEqual([]);
        release({ state: "completed", turnId: CHILD_TURN_ID, summary: "Kept result." });
      } else if (mode === "cancel") {
        release({ state: "failed", turnId: CHILD_TURN_ID, error: "Interrupted." });
      }
      await runtime.drain();
      return test;
    };

    const canceled = await checks("cancel");
    expect(canceled.commands.some((command) => command.type === "delegation.cancel")).toBe(true);
    expect(canceled.state.delegations.at(-1)?.phase._tag).toBe("Canceled");
    const kept = await checks("keep");
    expect(
      kept.commands.some((command) => command.type === "delegation.cancel" && command.keep),
    ).toBe(true);
    expect(kept.state.delegations.at(-1)?.phase._tag).toBe("Completed");
    expect((await checks("fail")).state.delegations.at(-1)).toMatchObject({
      phase: { _tag: "Failed", failure: { failureCode: "parent_failed" } },
    });
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

  it("still fails remaining children when one settlement write is rejected", async () => {
    let nextId = 0;
    const test = harness();
    const children: Array<PromiseWithResolvers<AkeruDelegationChildOutcome>> = [];
    const watchErrors: unknown[] = [];
    let rejectNextStateSet = false;
    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: async (command) => {
        if (rejectNextStateSet && command.type === "delegation.state.set") {
          rejectNextStateSet = false;
          throw new Error("state.set rejected");
        }
        await test.dispatch(command);
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

    // The first child's Failed write is rejected; the rejection must surface
    // through onWatchError without stopping the second child's settlement.
    rejectNextStateSet = true;
    await runtime.parentFinished({
      threadId: PARENT_THREAD_ID,
      turnId: PARENT_TURN_ID,
      failed: true,
    });
    children[0]!.resolve({ state: "failed", turnId: CHILD_TURN_ID, error: "Interrupted." });
    children[1]!.resolve({ state: "failed", turnId: CHILD_TURN_ID, error: "Interrupted." });
    await runtime.drain();

    expect(test.state.delegations[0]?.phase._tag).toBe("Running");
    expect(test.state.delegations[1]?.phase).toMatchObject({
      _tag: "Failed",
      failure: { failureCode: "parent_failed" },
    });
    // Both children stop, including the one whose Failed write was rejected.
    expect(test.interrupts).toHaveLength(2);
    expect(watchErrors).toHaveLength(1);
    expect(watchErrors[0]).toBeInstanceOf(Error);
    expect((watchErrors[0] as Error).message).toBe("state.set rejected");
  });

  it("persists child cancellation for the reactor after the runtime restarts", async () => {
    const childThreadId = ThreadId.make("persisted-child");
    const active = delegation(DelegationId.make("persisted-delegation"), {
      phase: { _tag: "Running", childThreadId, childTurnId: null, startedAt: NOW, progress: null },
    });
    const test = harness(snapshot({ delegations: [active] }));

    await test.runtime.parentFinished({
      threadId: PARENT_THREAD_ID,
      turnId: PARENT_TURN_ID,
      failed: false,
    });

    expect(test.state.delegations[0]?.phase._tag).toBe("Canceled");
    expect(test.commands.at(-1)).toMatchObject({
      type: "delegation.cancel",
      delegationId: active.delegationId,
      keep: false,
    });
    expect(test.interrupts).toEqual([]);
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

  it("runs a second delegation to a busy child bot in its own child chat", async () => {
    const test = harness();
    const children: Array<PromiseWithResolvers<AkeruDelegationChildOutcome>> = [];
    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: test.dispatch,
      awaitChild: () => {
        const child = Promise.withResolvers<AkeruDelegationChildOutcome>();
        children.push(child);
        return child.promise;
      },
      interruptChild: async () => undefined,
      now: () => NOW,
      id: (() => {
        let value = 0;
        return () => String(++value);
      })(),
    });

    const first = await runtime.send(parent(), request() as never);
    const second = await runtime.send(parent(), request({ task: "A follow-up." }) as never);
    expect(second.delegationId).not.toBe(first.delegationId);
    expect(second.childThreadId).not.toBe(first.childThreadId);
    expect(test.state.delegations.map((entry) => entry.phase._tag)).toEqual(["Running", "Running"]);

    children[1]!.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Second." });
    children[0]!.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "First." });
    await runtime.drain();
    expect(
      test.state.delegations.map((entry) =>
        entry.phase._tag === "Completed" ? entry.phase.result.summary : null,
      ),
    ).toEqual(["First.", "Second."]);
  });

  it("keeps children from an earlier completed turn when a later turn is interrupted", async () => {
    const childThreadId = ThreadId.make("earlier-child");
    const earlier = delegation(DelegationId.make("earlier"), {
      parentTurnId: TurnId.make("turn-earlier"),
      phase: { _tag: "Running", childThreadId, childTurnId: null, startedAt: NOW, progress: null },
    });
    const test = harness(snapshot({ delegations: [earlier] }));

    await test.runtime.parentFinished({
      threadId: PARENT_THREAD_ID,
      turnId: PARENT_TURN_ID,
      failed: false,
    });

    expect(test.state.delegations[0]?.phase._tag).toBe("Running");
    expect(test.commands).toEqual([]);
  });

  it("leaves stopped work canceled when the child finishes afterwards", async () => {
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

    await runtime.send(parent(), request() as never);
    await runtime.stop(parent(), { botId: CHILD_BOT_ID });
    child.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Too late." });
    await runtime.drain();

    expect(test.state.delegations[0]?.phase._tag).toBe("Canceled");
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

  it("refuses a legacy-bridge target before creating the child chat", async () => {
    const test = harness(
      snapshot({
        bots: [
          bot(PARENT_BOT_ID),
          bot(CHILD_BOT_ID, {
            name: "Legacy",
            engine: { provider: ProviderInstanceId.make("opencode"), model: "model" },
          }),
        ],
      }),
    );
    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state as OrchestrationReadModel,
      dispatch: test.dispatch,
      awaitChild: async () => ({ state: "completed", turnId: CHILD_TURN_ID, summary: "Done." }),
      interruptChild: async () => undefined,
      providerDriverKind: async (instanceId) => String(instanceId),
      now: () => NOW,
    });
    const refused = await runtime.send(parent(), request() as never).catch((cause) => cause);
    expect(Schema.is(AkeruDelegationProviderUnsupportedError)(refused)).toBe(true);
    expect(refused.message).toBe(
      "Legacy runs on the opencode provider, which cannot receive handed-off work. Do the work yourself or pick a bot on another provider.",
    );
    expect(test.commands).toEqual([]);
  });

  it("refuses a target whose provider instance is unknown before creating the child chat", async () => {
    const test = harness(
      snapshot({
        bots: [
          bot(PARENT_BOT_ID),
          bot(CHILD_BOT_ID, {
            engine: { provider: ProviderInstanceId.make("deleted-instance"), model: "model" },
          }),
        ],
      }),
      undefined,
      { providerDriverKind: async () => null },
    );
    await expect(test.runtime.send(parent(), request() as never)).rejects.toThrow(
      "The target bot is not available in this workspace.",
    );
    expect(test.commands).toEqual([]);
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
