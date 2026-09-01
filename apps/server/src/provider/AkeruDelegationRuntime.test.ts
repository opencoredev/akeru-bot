import {
  BotId,
  DelegationId,
  GroupId,
  McpServerId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AkeruDelegationAccessGrant,
  type AkeruDelegationRecord,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createAkeruDelegationRuntime,
  type AkeruDelegationChildOutcome,
  type AkeruDelegationParent,
} from "./AkeruDelegationRuntime.ts";
import { intersectDelegationAccess } from "./AkeruToolRuntime.ts";

const NOW = "2026-08-31T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const PARENT_BOT_ID = BotId.make("bot-parent");
const CHILD_BOT_ID = BotId.make("bot-child");
const OTHER_BOT_ID = BotId.make("bot-other");
const PARENT_THREAD_ID = ThreadId.make("thread-parent");
const PARENT_TURN_ID = TurnId.make("turn-parent");
const CHILD_TURN_ID = TurnId.make("turn-child");

const access = (overrides: Partial<AkeruDelegationAccessGrant> = {}) => ({
  allowedToolIds: ["Read", "Shell", "SendToAgent"] as const,
  memoryScopes: ["private", "bot", "project"] as const,
  sandbox: "local" as const,
  runtimeMode: "approval-required" as const,
  hasUserComputer: false,
  enabledMcpServerIds: [],
  disabledMcpServerIds: [],
  approvalCeiling: "send" as const,
  ...overrides,
});

function bot(id: BotId, overrides: Partial<OrchestrationBot> = {}): OrchestrationBot {
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
    channelBindings: [],
    groupId: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function thread(
  id: ThreadId,
  botId: BotId | null,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread {
  return {
    id,
    projectId: PROJECT_ID,
    botId,
    groupId: null,
    respondingBotId: null,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
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
    ...overrides,
  };
}

function delegation(
  delegationId: DelegationId,
  overrides: Partial<AkeruDelegationRecord> = {},
): AkeruDelegationRecord {
  return {
    delegationId,
    parentDelegationId: null,
    parentBotId: PARENT_BOT_ID,
    childBotId: CHILD_BOT_ID,
    parentThreadId: PARENT_THREAD_ID,
    childThreadId: null,
    parentTurnId: PARENT_TURN_ID,
    childTurnId: null,
    ancestorBotIds: [PARENT_BOT_ID],
    depth: 1,
    task: "Research the answer.",
    expectedResult: "A concise answer.",
    deadline: null,
    access: access(),
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

function snapshot(overrides: Partial<OrchestrationReadModel> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    bots: [bot(PARENT_BOT_ID), bot(CHILD_BOT_ID), bot(OTHER_BOT_ID)],
    groups: [],
    delegations: [],
    mcpServers: [],
    threads: [thread(PARENT_THREAD_ID, PARENT_BOT_ID)],
    updatedAt: NOW,
    ...overrides,
  };
}

const parent = (overrides: Partial<AkeruDelegationParent> = {}): AkeruDelegationParent => ({
  threadId: PARENT_THREAD_ID,
  turnId: PARENT_TURN_ID,
  botId: PARENT_BOT_ID,
  parentDelegationId: null,
  ancestorBotIds: [],
  depth: 0,
  access: access(),
  ...overrides,
});

const request = (overrides: Record<string, unknown> = {}) => ({
  botId: CHILD_BOT_ID,
  task: "Research the answer.",
  expectedResult: "A concise answer.",
  ...overrides,
});

function harness(
  initial = snapshot(),
  outcome: AkeruDelegationChildOutcome = {
    state: "completed",
    turnId: CHILD_TURN_ID,
    summary: "The delegated answer.",
  },
) {
  const state = {
    ...initial,
    delegations: [...initial.delegations],
    threads: [...initial.threads],
  };
  const commands: OrchestrationCommand[] = [];
  const interrupts: Array<{ threadId: ThreadId; turnId: TurnId | null }> = [];
  const usage: Array<Record<string, unknown>> = [];
  let nextId = 0;
  const dispatch = vi.fn(async (command: OrchestrationCommand) => {
    commands.push(command);
    if (command.type === "delegation.create") state.delegations.push(command.delegation);
    if (command.type === "delegation.state.set") {
      const index = state.delegations.findIndex(
        (entry) => entry.delegationId === command.delegation.delegationId,
      );
      if (index >= 0) state.delegations[index] = command.delegation;
    }
    if (command.type === "delegation.cancel") {
      const index = state.delegations.findIndex(
        (entry) => entry.delegationId === command.delegationId,
      );
      if (index >= 0) {
        state.delegations[index] = command.keep
          ? { ...state.delegations[index]!, keep: true }
          : {
              ...state.delegations[index]!,
              state: "canceled",
              completedAt: command.createdAt,
            };
      }
    }
    if (command.type === "thread.create") {
      state.threads.push(
        thread(command.threadId, command.botId ?? null, {
          groupId: command.groupId ?? null,
          runtimeMode: command.runtimeMode,
        }),
      );
    }
  });
  const recordUsage = vi.fn(async (entry: Record<string, unknown>) => {
    usage.push(entry);
  });
  const runtime = createAkeruDelegationRuntime({
    readSnapshot: async () => state as OrchestrationReadModel,
    dispatch,
    awaitChild: async () => outcome,
    interruptChild: async (threadId, turnId) => {
      interrupts.push({ threadId, turnId });
    },
    recordUsage,
    now: () => NOW,
    id: () => String(++nextId),
  });
  return { runtime, state, commands, interrupts, usage, dispatch };
}

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
    const result = await test.runtime.send(parent(), request() as never);
    expect(result).toMatchObject({
      summary: "The delegated answer.",
      childTurnId: CHILD_TURN_ID,
    });
    expect(result && "childThreadId" in result ? result.childThreadId : null).not.toBe(
      ThreadId.make("child"),
    );
    const create = test.commands.find((command) => command.type === "thread.create");
    expect(create).toMatchObject({ worktreePath: null });
    expect(create && "threadId" in create ? create.threadId : null).not.toBe(PARENT_THREAD_ID);
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

  it("rejects delegated memory until a bounded child packet exists", async () => {
    await expect(
      harness().runtime.send(parent(), request({ memoryScopes: ["project"] }) as never),
    ).rejects.toThrow("memory is unavailable");
  });

  it("preserves blocked state and persists child failure", async () => {
    const blocked = harness(snapshot(), {
      state: "blocked",
      turnId: CHILD_TURN_ID,
      error: "Access denied.",
    });
    await blocked.runtime.send(parent(), request() as never);
    expect(blocked.state.delegations.at(-1)).toMatchObject({
      state: "blocked",
      failure: null,
      billedBotId: CHILD_BOT_ID,
    });

    const failed = harness(snapshot(), {
      state: "failed",
      turnId: CHILD_TURN_ID,
      error: "Provider failed.",
    });
    await failed.runtime.send(parent(), request() as never);
    expect(failed.state.delegations.at(-1)).toMatchObject({
      state: "failed",
      failure: { failureCode: "child_failed" },
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
    expect(test.state.delegations.at(-1)).toMatchObject({
      state: "failed",
      failure: { failureCode: "timeout" },
    });
    expect(test.interrupts).toHaveLength(1);
  });

  it("cancels children on parent interrupt, preserves kept children, and marks parent failure", async () => {
    const checks = async (mode: "cancel" | "keep" | "fail") => {
      let release!: (outcome: AkeruDelegationChildOutcome) => void;
      const started = Promise.withResolvers<void>();
      const test = harness();
      const runtime = createAkeruDelegationRuntime({
        readSnapshot: async () => test.state,
        dispatch: async (command) => {
          await test.dispatch(command);
        },
        awaitChild: () =>
          new Promise((resolve) => {
            release = resolve;
            started.resolve();
          }),
        interruptChild: async (threadId, turnId) => {
          test.interrupts.push({ threadId, turnId });
          release({ state: "failed", turnId, error: "Interrupted." });
        },
        now: () => NOW,
        id: (() => {
          let value = 0;
          return () => String(++value);
        })(),
      });
      const pending = runtime.send(parent(), request() as never);
      await started.promise;
      const id = test.state.delegations[0]!.delegationId;
      await runtime.parentFinished({
        threadId: PARENT_THREAD_ID,
        failed: mode === "fail",
        ...(mode === "keep" ? { keep: new Set([id]) } : {}),
      });
      if (mode === "keep") {
        expect(test.interrupts).toEqual([]);
        release({ state: "completed", turnId: CHILD_TURN_ID, summary: "Kept result." });
      } else if (mode === "cancel") {
        release({ state: "failed", turnId: CHILD_TURN_ID, error: "Interrupted." });
      }
      await pending;
      return test;
    };

    const canceled = await checks("cancel");
    expect(canceled.commands.some((command) => command.type === "delegation.cancel")).toBe(true);
    expect(canceled.state.delegations.at(-1)?.state).toBe("canceled");
    const kept = await checks("keep");
    expect(
      kept.commands.some((command) => command.type === "delegation.cancel" && command.keep),
    ).toBe(true);
    expect(kept.state.delegations.at(-1)?.state).toBe("completed");
    expect((await checks("fail")).state.delegations.at(-1)).toMatchObject({
      state: "failed",
      failure: { failureCode: "parent_failed" },
    });
  });

  it("persists child cancellation for the reactor after the runtime restarts", async () => {
    const childThreadId = ThreadId.make("persisted-child");
    const active = delegation(DelegationId.make("persisted-delegation"), {
      childThreadId,
      state: "running",
      startedAt: NOW,
    });
    const test = harness(snapshot({ delegations: [active] }));

    await test.runtime.parentFinished({ threadId: PARENT_THREAD_ID, failed: false });

    expect(test.state.delegations[0]?.state).toBe("canceled");
    expect(test.commands.at(-1)).toMatchObject({
      type: "delegation.cancel",
      delegationId: active.delegationId,
      keep: false,
    });
    expect(test.interrupts).toEqual([]);
  });

  it("uses group-thread routing and does not treat a bot thread as a group", async () => {
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
      bots: [bot(PARENT_BOT_ID, { groupId }), bot(CHILD_BOT_ID, { groupId })],
      groups: [group],
      threads: [
        thread(PARENT_THREAD_ID, null, { groupId, respondingBotId: PARENT_BOT_ID }),
        thread(ThreadId.make("group-child"), null, { groupId }),
      ],
    });
    const test = harness(grouped);
    await test.runtime.send(parent(), request() as never);
    const groupTurn = test.commands.find((command) => command.type === "thread.turn.start");
    expect(groupTurn).toMatchObject({ respondingBotId: CHILD_BOT_ID });
    expect(groupTurn && "threadId" in groupTurn ? groupTurn.threadId : null).not.toBe(
      ThreadId.make("group-child"),
    );

    await expect(
      harness(
        snapshot({
          bots: [bot(PARENT_BOT_ID), bot(CHILD_BOT_ID, { groupId })],
          groups: [group],
        }),
      ).runtime.send(parent(), request() as never),
    ).rejects.toThrow("current group");
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
