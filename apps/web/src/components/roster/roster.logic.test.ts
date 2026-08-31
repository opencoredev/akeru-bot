import { BotId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  blinkDelayMs,
  buildGroupedRosterSections,
  buildRosterSections,
  buildRosterStrip,
  buildRosterTiles,
  compareRosterBots,
  filterRosterBots,
  filterRosterGroups,
  DEFAULT_BLOB_COLOR,
  DEFAULT_BLOB_SHAPE,
  formatRosterTimestamp,
  groupContainsBot,
  isRecordableChatPath,
  parseChatPath,
  randomBotAvatar,
  resolveBlobRendering,
  resolveBotPresence,
  resolveLatestRosterMessage,
  resolveRosterBotId,
  resolveRosterIndicator,
  parseRosterBotDragId,
  parseRosterGroupDropId,
  rosterBotDragId,
  rosterGroupDropId,
  BLOB_COLORS,
  BLOB_SHAPES,
  type RosterLastMessage,
} from "./roster.logic";
import type { Bot, BotAvatar, Group } from "./types";

function bot(input: Partial<Bot> & Pick<Bot, "id" | "name">): Bot {
  return {
    title: "Bot",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
    engine: null,
    sandbox: null,
    runtimeMode: "full-access",
    usageCap: null,
    voiceEnabled: false,
    groupId: null,
    pinned: false,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...input,
  };
}

describe("resolveRosterBotId", () => {
  it("does not redirect to a persisted bot that is absent from the loaded roster", () => {
    expect(resolveRosterBotId("missing", [])).toBeNull();
    expect(
      resolveRosterBotId("missing", [
        bot({ id: "available", name: "Available" }),
        bot({ id: "archived", name: "Archived", archivedAt: "2026-08-02T00:00:00.000Z" }),
      ]),
    ).toBe("available");
  });
});

describe("buildRosterSections", () => {
  it("partitions only bots by their binary pin state", () => {
    const sections = buildRosterSections([
      bot({ id: "pinned-a", name: "Pinned A", pinned: true }),
      bot({ id: "plain-a", name: "Plain A" }),
      bot({ id: "pinned-b", name: "Pinned B", pinned: true }),
      bot({ id: "plain-b", name: "Plain B" }),
    ]);

    expect(sections.map((section) => section.name)).toEqual(["Pinned", "Bots"]);
    expect(sections[0]?.bots.map((entry) => entry.id)).toEqual(["pinned-a", "pinned-b"]);
    expect(sections[1]?.bots.map((entry) => entry.id)).toEqual(["plain-a", "plain-b"]);
  });

  it("hides archived bots without changing persisted order", () => {
    const sections = buildRosterSections([
      bot({ id: "first", name: "First" }),
      bot({ id: "gone", name: "Gone", archivedAt: "2026-08-20T00:00:00.000Z" }),
      bot({ id: "second", name: "Second" }),
    ]);

    expect(sections[0]?.bots.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("unwraps the previous object call shape during a hot update", () => {
    const sections = buildRosterSections({
      bots: [bot({ id: "pinned", name: "Pinned", pinned: true })],
    });

    expect(sections[0]?.bots.map((entry) => entry.id)).toEqual(["pinned"]);
  });
});

describe("buildGroupedRosterSections", () => {
  const group: Group = {
    id: "group-product",
    name: "Product",
    bossBotId: "assigned",
    members: [{ kind: "bot", botId: BotId.make("assigned"), role: "boss" }],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };

  it("uses group membership instead of the legacy bot group ID", () => {
    const member = bot({ id: "assigned", name: "Assigned", groupId: null });

    expect(groupContainsBot(group, member.id)).toBe(true);
  });

  it("shows assigned groups before Unassigned and leaves pinned bots in the strip", () => {
    const sections = buildGroupedRosterSections(
      [
        bot({ id: "assigned", name: "Assigned", groupId: group.id }),
        bot({ id: "free", name: "Free" }),
        bot({ id: "pinned", name: "Pinned", groupId: group.id, pinned: true }),
      ],
      [group],
    );

    expect(sections.map((section) => section.name)).toEqual(["Product", "Unassigned"]);
    expect(sections[0]?.bots.map((entry) => entry.id)).toEqual(["assigned"]);
    expect(sections[1]?.bots.map((entry) => entry.id)).toEqual(["free"]);
  });
});

describe("buildRosterStrip", () => {
  it("hides archived bots and puts pinned bots first without recency sorting", () => {
    const strip = buildRosterStrip(
      [
        bot({ id: "quiet", name: "Quiet" }),
        bot({ id: "gone", name: "Gone", archivedAt: "2026-08-20T00:00:00.000Z" }),
        bot({ id: "pinned", name: "Pinned", pinned: true }),
        bot({ id: "busy", name: "Busy" }),
      ],
      { busy: { text: "hi", at: "2026-08-27T10:00:00.000Z" } },
    );
    expect(strip.map((entry) => entry.id)).toEqual(["pinned", "quiet", "busy"]);
  });
});

describe("buildRosterTiles", () => {
  it("shows at most five recent bots without limiting the rail", () => {
    const bots = Array.from({ length: 7 }, (_, index) =>
      bot({ id: `bot-${index}`, name: `Bot ${index}`, pinned: true }),
    );
    const messages = Object.fromEntries(
      bots.map((entry, index) => [
        entry.id,
        { text: `${index}`, at: `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00.000Z` },
      ]),
    );

    expect(buildRosterTiles(bots, messages).map((entry) => entry.id)).toEqual([
      "bot-0",
      "bot-1",
      "bot-2",
      "bot-3",
      "bot-4",
    ]);
    expect(buildRosterStrip(bots, messages)).toHaveLength(7);
  });
});

describe("filterRosterBots", () => {
  const bots = [
    bot({ id: "1", name: "Akeru", label: "Research", description: "Finds evidence" }),
    bot({ id: "2", name: "Mori", label: "Design", description: "Reviews interfaces" }),
  ];

  it("matches everything on a blank query", () => {
    expect(filterRosterBots(bots, "  ").map((entry) => entry.id)).toEqual(["1", "2"]);
  });

  it("matches the bot profile case-insensitively", () => {
    expect(filterRosterBots(bots, "MORI").map((entry) => entry.id)).toEqual(["2"]);
    expect(filterRosterBots(bots, "research").map((entry) => entry.id)).toEqual(["1"]);
    expect(filterRosterBots(bots, "interfaces").map((entry) => entry.id)).toEqual(["2"]);
    expect(filterRosterBots(bots, "nobody")).toEqual([]);
  });
});

describe("filterRosterGroups", () => {
  const bots = [bot({ id: "boss", name: "Akeru" }), bot({ id: "specialist", name: "Mori" })];
  const groups: Group[] = [
    {
      id: "launch",
      name: "Launch crew",
      bossBotId: "boss",
      members: [
        { kind: "bot", botId: BotId.make("boss"), role: "boss" },
        { kind: "bot", botId: BotId.make("specialist"), role: "specialist" },
      ],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
  ];

  it("matches a group by its name or a member bot name", () => {
    expect(filterRosterGroups(groups, bots, "launch")).toHaveLength(1);
    expect(filterRosterGroups(groups, bots, "MORI")).toHaveLength(1);
    expect(filterRosterGroups(groups, bots, "nobody")).toEqual([]);
  });
});

describe("roster drag ids", () => {
  it("keeps bot and group targets distinct", () => {
    expect(parseRosterBotDragId(rosterBotDragId("same"))).toBe("same");
    expect(parseRosterGroupDropId(rosterGroupDropId("same"))).toBe("same");
    expect(parseRosterBotDragId(rosterGroupDropId("same"))).toBeNull();
    expect(parseRosterGroupDropId(rosterBotDragId("same"))).toBeNull();
    expect(parseRosterBotDragId("bot:")).toBeNull();
    expect(parseRosterGroupDropId("group:")).toBeNull();
  });
});

describe("randomBotAvatar", () => {
  it("returns a valid blob and never picks white", () => {
    for (let i = 0; i < 20; i++) {
      const avatar = randomBotAvatar(() => i / 20);
      expect(avatar.kind).toBe("blob");
      if (avatar.kind !== "blob") continue;
      expect(BLOB_SHAPES).toContain(avatar.shape);
      expect(BLOB_COLORS).toContain(avatar.color);
      expect(avatar.color).not.toBe("#FFFFFF");
    }
  });

  it("is deterministic for an injected random source", () => {
    expect(randomBotAvatar(() => 0)).toEqual(randomBotAvatar(() => 0));
  });
});

describe("resolveRosterIndicator", () => {
  it("shows yellow for needs-you, green for working, and nothing for idle", () => {
    expect(resolveRosterIndicator("needs-you")).toBe("needs-you");
    expect(resolveRosterIndicator("working")).toBe("working");
    expect(resolveRosterIndicator("idle")).toBeNull();
  });
});

describe("resolveBotPresence", () => {
  const shell = (input: {
    status?: string;
    activeTurnId?: string | null;
    hasPendingApprovals?: boolean;
    hasPendingUserInput?: boolean;
    backgroundLiveness?: "working" | "monitoring" | null;
  }) =>
    ({
      session:
        input.status === undefined
          ? null
          : { status: input.status, activeTurnId: input.activeTurnId ?? null },
      hasPendingApprovals: input.hasPendingApprovals ?? false,
      hasPendingUserInput: input.hasPendingUserInput ?? false,
      backgroundLiveness: input.backgroundLiveness ?? null,
    }) as Parameters<typeof resolveBotPresence>[0];

  it("is idle without a linked thread or running turn", () => {
    expect(resolveBotPresence(null)).toBe("idle");
    expect(resolveBotPresence(shell({}))).toBe("idle");
    expect(resolveBotPresence(shell({ status: "running", activeTurnId: null }))).toBe("idle");
    expect(resolveBotPresence(shell({ status: "ready" }))).toBe("idle");
  });

  it("works while a turn runs or background work stays live", () => {
    expect(resolveBotPresence(shell({ status: "running", activeTurnId: "turn-1" }))).toBe(
      "working",
    );
    expect(resolveBotPresence(shell({ backgroundLiveness: "working" }))).toBe("working");
    expect(resolveBotPresence(shell({ backgroundLiveness: "monitoring" }))).toBe("idle");
  });

  it("needs-you outranks a running turn", () => {
    expect(
      resolveBotPresence(
        shell({ status: "running", activeTurnId: "turn-1", hasPendingApprovals: true }),
      ),
    ).toBe("needs-you");
    expect(resolveBotPresence(shell({ hasPendingUserInput: true }))).toBe("needs-you");
  });
});

describe("resolveLatestRosterMessage", () => {
  const messages = (
    entries: Array<{ role: "user" | "assistant" | "system"; text: string; at: string }>,
  ) =>
    entries.map((entry, index) => ({
      id: `message-${index}`,
      role: entry.role,
      text: entry.text,
      turnId: null,
      streaming: false,
      createdAt: entry.at,
      updatedAt: entry.at,
    })) as Parameters<typeof resolveLatestRosterMessage>[1];

  it("uses the latest real user or provider message and its timestamp", () => {
    expect(
      resolveLatestRosterMessage(
        { text: "handoff", at: "2026-08-20T10:00:00.000Z" },
        messages([
          { role: "user", text: "Question", at: "2026-08-20T10:01:00.000Z" },
          { role: "assistant", text: "Answer", at: "2026-08-20T10:02:00.000Z" },
        ]),
      ),
    ).toEqual({ text: "Answer", at: "2026-08-20T10:02:00.000Z" });
  });

  it("keeps a newer handoff preview and ignores system or empty messages", () => {
    const fallback = { text: "Newest prompt", at: "2026-08-20T10:03:00.000Z" };
    expect(
      resolveLatestRosterMessage(
        fallback,
        messages([
          { role: "assistant", text: "Older answer", at: "2026-08-20T10:02:00.000Z" },
          { role: "system", text: "Internal", at: "2026-08-20T10:04:00.000Z" },
          { role: "assistant", text: "", at: "2026-08-20T10:05:00.000Z" },
        ]),
      ),
    ).toEqual(fallback);
  });
});

describe("compareRosterBots", () => {
  const lastMessageByBotId: Record<string, RosterLastMessage> = {
    older: { text: "old", at: "2026-08-25T10:00:00.000Z" },
    newer: { text: "new", at: "2026-08-27T10:00:00.000Z" },
  };

  it("sorts the latest conversation first", () => {
    const sorted = [bot({ id: "older", name: "Older" }), bot({ id: "newer", name: "Newer" })].sort(
      (a, b) => compareRosterBots(a, b, lastMessageByBotId),
    );
    expect(sorted.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });

  it("puts bots without messages after those with, alphabetized", () => {
    const sorted = [
      bot({ id: "quiet-b", name: "Zed" }),
      bot({ id: "older", name: "Older" }),
      bot({ id: "quiet-a", name: "Ada" }),
    ].sort((a, b) => compareRosterBots(a, b, lastMessageByBotId));
    expect(sorted.map((entry) => entry.id)).toEqual(["older", "quiet-a", "quiet-b"]);
  });

  it("treats an unparseable timestamp as no message", () => {
    const sorted = [
      bot({ id: "broken", name: "Broken" }),
      bot({ id: "older", name: "Older" }),
    ].sort((a, b) =>
      compareRosterBots(a, b, {
        ...lastMessageByBotId,
        broken: { text: "?", at: "not-a-date" },
      }),
    );
    expect(sorted.map((entry) => entry.id)).toEqual(["older", "broken"]);
  });
});

describe("resolveBlobRendering", () => {
  it("passes a valid blob avatar through", () => {
    expect(resolveBlobRendering({ kind: "blob", shape: "hex", color: "#5BA97B" })).toEqual({
      shape: "hex",
      color: "#5BA97B",
    });
  });

  it("falls back to the default blob for non-blob kinds", () => {
    expect(resolveBlobRendering({ kind: "dither", seed: "abc" })).toEqual({
      shape: DEFAULT_BLOB_SHAPE,
      color: DEFAULT_BLOB_COLOR,
    });
    expect(resolveBlobRendering({ kind: "image", assetPath: "/a.png", dithered: false })).toEqual({
      shape: DEFAULT_BLOB_SHAPE,
      color: DEFAULT_BLOB_COLOR,
    });
    expect(resolveBlobRendering(null)).toEqual({
      shape: DEFAULT_BLOB_SHAPE,
      color: DEFAULT_BLOB_COLOR,
    });
  });

  it("falls back for an unknown shape or empty color from persisted data", () => {
    const persisted = { kind: "blob", shape: "starburst", color: "" } as unknown as BotAvatar;
    expect(resolveBlobRendering(persisted)).toEqual({
      shape: DEFAULT_BLOB_SHAPE,
      color: DEFAULT_BLOB_COLOR,
    });
  });

  it("falls back for a retired shape name", () => {
    const persisted = { kind: "blob", shape: "pebble", color: "#FFFFFF" } as unknown as BotAvatar;
    expect(resolveBlobRendering(persisted)).toEqual({
      shape: DEFAULT_BLOB_SHAPE,
      color: "#FFFFFF",
    });
  });
});

describe("blinkDelayMs", () => {
  it("is a stable phase offset within one blink cycle", () => {
    expect(blinkDelayMs("Akeru")).toBe(blinkDelayMs("Akeru"));
    expect(blinkDelayMs("Akeru")).toBeLessThanOrEqual(0);
    expect(blinkDelayMs("Akeru")).toBeGreaterThan(-6400);
  });

  it("staggers different bots", () => {
    expect(blinkDelayMs("Akeru")).not.toBe(blinkDelayMs("Mori"));
  });
});

describe("formatRosterTimestamp", () => {
  const now = new Date("2026-08-27T15:00:00").getTime();

  it("shows a clock time today, Yesterday, then weekday, then date", () => {
    expect(formatRosterTimestamp("2026-08-27T09:30:00", "24-hour", now)).toBe("09:30");
    expect(formatRosterTimestamp("2026-08-26T09:30:00", "24-hour", now)).toBe("Yesterday");
    expect(formatRosterTimestamp("2026-08-24T09:30:00", "24-hour", now)).not.toContain(":");
    expect(formatRosterTimestamp("2026-01-02T09:30:00", "24-hour", now)).toContain("2");
  });

  it("returns empty for an invalid date", () => {
    expect(formatRosterTimestamp("nope", "24-hour", now)).toBe("");
  });
});

describe("parseChatPath", () => {
  it("parses a legacy server thread route", () => {
    expect(parseChatPath("/env-1/thread-9")).toEqual({
      kind: "thread",
      environmentId: "env-1",
      threadId: "thread-9",
    });
  });

  it("rejects non-chat routes", () => {
    expect(isRecordableChatPath("/")).toBe(false);
    expect(isRecordableChatPath("/settings/appearance")).toBe(false);
    expect(isRecordableChatPath("/projects/my-project")).toBe(false);
    expect(isRecordableChatPath("/bots/bot-akeru")).toBe(false);
    expect(isRecordableChatPath("/draft/draft-123")).toBe(false);
    expect(isRecordableChatPath("/usage")).toBe(false);
  });
});
