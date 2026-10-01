import { BotId, GroupId, ThreadId } from "@akeru/contracts";
import { makeMobileBot, makeMobileGroup } from "../../lib/mobile-fixtures.test-support";
import type { OrchestrationBot, OrchestrationGroup } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadIdentity, groupChatBots } from "./threadIdentity";

function bot(overrides: Partial<OrchestrationBot> = {}): OrchestrationBot {
  return makeMobileBot({
    id: BotId.make("bot-1"),
    name: "Mira",
    archivedAt: null,
    ...overrides,
  });
}

function group(overrides: Partial<OrchestrationGroup> = {}): OrchestrationGroup {
  return makeMobileGroup({
    id: GroupId.make("group-1"),
    name: "Mira and Ren",
    bossBotId: null,
    members: [
      { kind: "bot", botId: BotId.make("bot-1"), role: "boss" },
      { kind: "bot", botId: BotId.make("bot-2"), role: "specialist" },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

const threadBase = {
  id: ThreadId.make("thread-1"),
  title: "Proofread release notes",
  botId: null,
  groupId: null,
};

const noProviderName = () => null;

describe("resolveThreadIdentity", () => {
  it("titles a group chat with the group name and member bots", () => {
    const g = group();
    const bots = [bot(), bot({ id: BotId.make("bot-2"), name: "Ren" })];

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
    const g = group({ bossBotId: BotId.make("bot-2") });
    const bots = [bot(), bot({ id: BotId.make("bot-2"), name: "Ren" })];

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
