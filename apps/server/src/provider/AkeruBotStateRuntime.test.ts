import { BotId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createEmptyReadModel } from "../orchestration/projector.ts";
import { createAkeruBotStateRuntime } from "./AkeruBotStateRuntime.ts";

const now = "2026-09-01T02:00:00.000Z";
const botId = BotId.make("bot-self");
const otherBotId = BotId.make("bot-other");

function snapshot(archivedAt: string | null = null) {
  return {
    ...createEmptyReadModel(now),
    bots: [
      {
        id: botId,
        name: "Researcher",
        title: "Research bot",
        label: null,
        description: null,
        disabledMcpServerIds: [],
        avatar: { kind: "dither" as const, seed: "researcher" },
        engine: null,
        sandbox: "local" as const,
        runtimeMode: "approval-required" as const,
        usageCap: null,
        voiceEnabled: false,
        groupId: null,
        archivedAt,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherBotId,
        name: "Other",
        title: "Other bot",
        label: null,
        description: null,
        disabledMcpServerIds: [],
        avatar: { kind: "dither" as const, seed: "other" },
        engine: null,
        sandbox: "local" as const,
        runtimeMode: "approval-required" as const,
        usageCap: null,
        voiceEnabled: false,
        groupId: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

describe("AkeruBotStateRuntime", () => {
  it("updates only the session bot and returns an event-backed receipt", async () => {
    const commands: OrchestrationCommand[] = [];
    const runtime = createAkeruBotStateRuntime({
      readSnapshot: async () => snapshot(),
      dispatch: async (command) => {
        commands.push(command);
        return { sequence: 42 };
      },
      now: () => now,
      id: () => "command-1",
    });

    await expect(
      runtime.updateProfile(ThreadId.make("thread-1"), botId, "tool-1", {
        name: "Source checker",
        label: null,
      }),
    ).resolves.toEqual({
      receiptId: "tool-1",
      toolId: "UpdateBotProfile",
      phase: "success",
      threadId: "thread-1",
      botId,
      summary: "Bot profile updated at event sequence 42.",
      fatalToThread: false,
      billedBotId: botId,
      createdAt: now,
    });
    expect(commands).toEqual([
      {
        type: "bot.update",
        commandId: "bot-state:profile:command-1",
        botId,
        name: "Source checker",
        label: null,
      },
    ]);
  });

  it("does not dispatch for a missing or archived session bot", async () => {
    const dispatch = vi.fn(async (_command: OrchestrationCommand) => ({ sequence: 1 }));
    const archived = createAkeruBotStateRuntime({
      readSnapshot: async () => snapshot(now),
      dispatch,
    });
    const missing = createAkeruBotStateRuntime({
      readSnapshot: async () => snapshot(),
      dispatch,
    });

    await expect(
      archived.updateProfile(ThreadId.make("thread-1"), botId, "tool-1", { title: "New" }),
    ).rejects.toThrow("not available");
    await expect(
      missing.updateProfile(ThreadId.make("thread-1"), BotId.make("missing"), "tool-2", {
        title: "New",
      }),
    ).rejects.toThrow("not available");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
