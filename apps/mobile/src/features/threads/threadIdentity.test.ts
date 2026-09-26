import type { OrchestrationBot, OrchestrationGroup } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadIdentity, groupChatBots } from "./threadIdentity";

function bot(overrides: Partial<OrchestrationBot> = {}): OrchestrationBot {
  return {
    id: "bot-1" as never,
    name: "Mira",
    avatar: null,
    archivedAt: null,
    ...overrides,
  } as unknown as OrchestrationBot;
}

function group(overrides: Partial<OrchestrationGroup> = {}): OrchestrationGroup {
  return {
    id: "group-1" as never,
    name: "Mira and Ren",
    bossBotId: null,
    members: [
      { kind: "bot", botId: "bot-1", role: "boss" },
      { kind: "bot", botId: "bot-2", role: "specialist" },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as unknown as OrchestrationGroup;
}

const threadBase = {
  id: "thread-1" as never,
  title: "Proofread release notes",
  botId: null,
  groupId: null,
};

const noProviderName = () => null;

describe("resolveThreadIdentity", () => {
  it("titles a group chat with the group name and member bots", () => {
    const g = group();
    const bots = [bot(), bot({ id: "bot-2" as never, name: "Ren" })];

    const identity = resolveThreadIdentity({
      thread: { ...threadBase, groupId: g.id },
      bots,
      groups: [g],
      providerDriver: "codex",
      providerName: () => "Codex",
    });

    expect(identity.title).toBe("Mira and Ren");
    expect(identity.isGroup).toBe(true);
    expect(identity.bots.map((b) => b.name)).toEqual(["Mira", "Ren"]);
  });

  it("leads the member stack with the group boss", () => {
    const g = group({ bossBotId: "bot-2" as never });
    const bots = [bot(), bot({ id: "bot-2" as never, name: "Ren" })];

    expect(groupChatBots(g, bots).map((b) => b.name)).toEqual(["Ren", "Mira"]);
  });

  it("keeps bot chats on bot name and avatar", () => {
    const mira = bot();

    const identity = resolveThreadIdentity({
      thread: { ...threadBase, botId: mira.id },
      bots: [mira],
      groups: [],
      providerDriver: "codex",
      providerName: () => "Codex",
    });

    expect(identity.title).toBe("Mira");
    expect(identity.isGroup).toBe(false);
    expect(identity.bots).toEqual([mira]);
  });

  it("falls back to the provider name, then the thread title, for plain chats", () => {
    expect(
      resolveThreadIdentity({
        thread: threadBase,
        bots: [],
        groups: [],
        providerDriver: "codex",
        providerName: () => "Codex",
      }).title,
    ).toBe("Codex");

    expect(
      resolveThreadIdentity({
        thread: threadBase,
        bots: [],
        groups: [],
        providerDriver: null,
        providerName: noProviderName,
      }).title,
    ).toBe("Proofread release notes");
  });
});
