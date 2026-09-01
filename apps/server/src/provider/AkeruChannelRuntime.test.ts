import { BotId, GroupId, type OrchestrationReadModel } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAkeruChannelRuntime } from "./AkeruChannelRuntime.ts";

const now = "2026-09-01T00:00:00.000Z";
const bossBotId = BotId.make("boss");
const specialistBotId = BotId.make("specialist");
const channelId = GroupId.make("channel-1");

const bot = (id: BotId, groupId: GroupId | null) => ({
  id,
  name: id,
  title: id,
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither" as const, seed: id },
  engine: null,
  sandbox: "local" as const,
  runtimeMode: "approval-required" as const,
  usageCap: null,
  voiceEnabled: false,
  groupId,
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
});

const snapshot: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  bots: [bot(bossBotId, channelId), bot(specialistBotId, channelId)],
  groups: [
    {
      id: channelId,
      name: "Launch",
      bossBotId,
      members: [
        { botId: bossBotId, role: "boss" },
        { botId: specialistBotId, role: "specialist" },
      ],
      createdAt: now,
      updatedAt: now,
    },
  ],
  delegations: [],
  threads: [],
  updatedAt: now,
};

describe("AkeruChannelRuntime", () => {
  it("creates a persisted group with the calling bot as boss", async () => {
    const dispatch = vi.fn();
    const runtime = createAkeruChannelRuntime({
      readSnapshot: async () => ({ ...snapshot, groups: [], bots: [bot(bossBotId, null)] }),
      dispatch,
      now: () => now,
      id: () => "1",
    });

    await expect(runtime.create(bossBotId, { name: "Research" })).resolves.toBe("channel-1");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "group.create",
        groupId: "channel-1",
        name: "Research",
        bossBotId,
      }),
    );
  });

  it("lets the existing boss rename a channel", async () => {
    const dispatch = vi.fn();
    const runtime = createAkeruChannelRuntime({
      readSnapshot: async () => snapshot,
      dispatch,
      id: () => "1",
    });

    await runtime.update(bossBotId, { channelId, name: "Launch room" });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "group.rename", groupId: channelId, name: "Launch room" }),
    );
  });

  it("rejects updates from specialists and missing channels", async () => {
    const dispatch = vi.fn();
    const runtime = createAkeruChannelRuntime({
      readSnapshot: async () => snapshot,
      dispatch,
    });

    await expect(runtime.update(specialistBotId, { channelId, name: "Hijacked" })).rejects.toThrow(
      "Only the channel boss",
    );
    await expect(
      runtime.update(bossBotId, { channelId: GroupId.make("missing"), name: "Missing" }),
    ).rejects.toThrow("does not exist");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
