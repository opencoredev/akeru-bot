import { describe, expect, it, vi } from "@effect/vitest";

import {
  BotId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationBot,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { createAkeruDelegationRuntime } from "./AkeruDelegationRuntime.ts";

const sourceBotId = BotId.make("source-bot");
const targetBotId = BotId.make("target-bot");
const sourceThreadId = ThreadId.make("source-thread");
const sourceTurnId = TurnId.make("source-turn");
const now = "2026-09-01T00:00:00.000Z";

const targetBot: OrchestrationBot = {
  id: targetBotId,
  name: "Reviewer",
  title: "Reviewer",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither", seed: "reviewer" },
  engine: null,
  sandbox: "local",
  runtimeMode: "approval-required",
  usageCap: null,
  voiceEnabled: false,
  groupId: null,
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
};

const sourceThread: OrchestrationThread = {
  id: sourceThreadId,
  projectId: ProjectId.make("project-1"),
  botId: sourceBotId,
  groupId: null,
  respondingBotId: null,
  title: "Source thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
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

const snapshot: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  bots: [targetBot],
  groups: [],
  delegations: [],
  threads: [sourceThread],
  updatedAt: now,
};

const request = { botId: targetBotId, task: "Review the patch", expectedResult: "A verdict" };

describe("AkeruDelegationRuntime", () => {
  it("enforces depth from the server-owned parent context", async () => {
    const dispatch = vi.fn();
    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => snapshot,
      dispatch,
      awaitChild: vi.fn(),
    });

    await expect(
      runtime.send(
        { threadId: sourceThreadId, turnId: sourceTurnId, botId: sourceBotId, depth: 2 },
        request,
      ),
    ).rejects.toThrow("Delegation depth cannot exceed 2");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches the child turn and bills its performing bot", async () => {
    const commands: Array<{ type: string; [key: string]: unknown }> = [];
    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => snapshot,
      dispatch: async (command) => commands.push(command),
      awaitChild: async () => ({
        turnId: TurnId.make("child-turn"),
        result: "The patch is correct.",
        usage: { inputTokens: 11, outputTokens: 7 },
      }),
      now: () => now,
      id: (() => {
        let value = 0;
        return () => String(++value);
      })(),
    });

    const receipt = await runtime.send(
      { threadId: sourceThreadId, turnId: sourceTurnId, botId: sourceBotId, depth: 0 },
      request,
    );

    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "delegation.create",
      "thread.turn.start",
      "delegation.complete",
    ]);
    expect(receipt).toMatchObject({
      phase: "success",
      fatalToThread: false,
      botId: sourceBotId,
      billedBotId: targetBotId,
      usage: { inputTokens: 11, outputTokens: 7 },
    });
  });

  it("returns a nonfatal receipt when the child fails", async () => {
    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => snapshot,
      dispatch: async () => undefined,
      awaitChild: async () => ({ turnId: null, error: "Provider unavailable" }),
    });

    await expect(
      runtime.send(
        { threadId: sourceThreadId, turnId: sourceTurnId, botId: sourceBotId, depth: 1 },
        request,
      ),
    ).resolves.toMatchObject({
      phase: "failure",
      failureCode: "internal",
      fatalToThread: false,
      billedBotId: targetBotId,
      summary: "Provider unavailable",
    });
  });
});
