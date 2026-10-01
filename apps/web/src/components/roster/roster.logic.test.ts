import { BotId } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archivedRosterBots,
  buildGroupedRosterSections,
  buildRosterSections,
  buildRosterStrip,
  buildRosterTiles,
  filterRosterBots,
  filterRosterGroups,
  orderRosterBotsForShortcuts,
  resolveBotPresence,
  resolveRosterBotId,
  resolveRosterIndicator,
  resolveAdjacentRosterBot,
  resolveRosterShortcutBot,
  rosterZoneHeading,
} from "./roster.logic";
import { bot } from "./roster.test-support";
import type { Group } from "./types";

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

describe("rosterZoneHeading", () => {
  it("names what the zone holds instead of calling a group a bot", () => {
    expect(rosterZoneHeading([{ kind: "bot", id: "one" }])).toBe("Bots");
    expect(rosterZoneHeading([{ kind: "group", id: "product" }])).toBe("Groups");
    expect(
      rosterZoneHeading([
        { kind: "bot", id: "one" },
        { kind: "group", id: "product" },
      ]),
    ).toBe("Bots and groups");
    expect(rosterZoneHeading([])).toBe("Bots");
  });
});

describe("archivedRosterBots", () => {
  it("lists archived bots newest first and leaves active bots out", () => {
    const archived = archivedRosterBots([
      bot({ id: "active", name: "Active" }),
      bot({ id: "older", name: "Older", archivedAt: "2026-08-02T00:00:00.000Z" }),
      bot({ id: "newer", name: "Newer", archivedAt: "2026-08-09T00:00:00.000Z" }),
    ]);

    expect(archived.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });
});

describe("buildGroupedRosterSections", () => {
  const group: Group = {
    id: "group-product",
    name: "Product",
    bossBotId: BotId.make("assigned"),
    members: [{ kind: "bot", botId: BotId.make("assigned"), role: "boss" }],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };

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

  it("keeps every group member when the group name matches a search", () => {
    const sections = buildGroupedRosterSections(
      [
        bot({ id: "atlas", name: "Atlas", groupId: group.id }),
        bot({ id: "mori", name: "Mori", groupId: group.id }),
        bot({ id: "free", name: "Free" }),
      ],
      [group],
      "product",
    );

    expect(sections.map((section) => section.name)).toEqual(["Product"]);
    expect(sections[0]?.bots.map((entry) => entry.id)).toEqual(["atlas", "mori"]);
  });

  it("keeps every group member when one member matches a search", () => {
    const sections = buildGroupedRosterSections(
      [
        bot({ id: "atlas", name: "Atlas", groupId: group.id }),
        bot({ id: "mori", name: "Mori", groupId: group.id }),
      ],
      [group],
      "atlas",
    );

    expect(sections[0]?.bots.map((entry) => entry.id)).toEqual(["atlas", "mori"]);
  });

  it("hides a name-matching group when every member is pinned or archived", () => {
    const sections = buildGroupedRosterSections(
      [
        bot({ id: "atlas", name: "Atlas", groupId: group.id, pinned: true }),
        bot({
          id: "gone",
          name: "Gone",
          groupId: group.id,
          archivedAt: "2026-08-20T00:00:00.000Z",
        }),
      ],
      [group],
      "product",
    );

    expect(sections).toEqual([]);
  });

  it("hides groups whose name and members miss the search", () => {
    const sections = buildGroupedRosterSections(
      [bot({ id: "atlas", name: "Atlas", groupId: group.id }), bot({ id: "free", name: "Free" })],
      [group],
      "asdfasdf",
    );

    expect(sections).toEqual([]);
  });

  it("keeps only matching unassigned bots", () => {
    const sections = buildGroupedRosterSections(
      [
        bot({ id: "1", name: "Akeru", label: "Research" }),
        bot({ id: "2", name: "Mori", label: "Design" }),
      ],
      [],
      "research",
    );

    expect(sections.map((section) => section.name)).toEqual(["Unassigned"]);
    expect(sections[0]?.bots.map((entry) => entry.id)).toEqual(["1"]);
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

describe("roster bot shortcuts", () => {
  it("puts pinned bots first, then follows section and unassigned order", () => {
    const bots = [
      bot({ id: "free-a", name: "Free A" }),
      bot({ id: "section-b", name: "Section B" }),
      bot({ id: "pinned-a", name: "Pinned A" }),
      bot({ id: "section-a", name: "Section A" }),
      bot({ id: "pinned-b", name: "Pinned B" }),
      bot({ id: "archived", name: "Archived", archivedAt: "2026-08-20T00:00:00.000Z" }),
      bot({ id: "free-b", name: "Free B" }),
    ];

    const ordered = orderRosterBotsForShortcuts(
      bots,
      [
        { kind: "group", id: "group-a" },
        { kind: "bot", id: "pinned-b" },
        { kind: "bot", id: "archived" },
        { kind: "bot", id: "pinned-a" },
      ],
      [{ botIds: ["section-a", "pinned-a", "section-b"] }],
    );

    expect(ordered.map((entry) => entry.id)).toEqual([
      "pinned-b",
      "pinned-a",
      "section-a",
      "section-b",
      "free-a",
      "free-b",
    ]);
  });

  it("maps jump commands to the matching bot and ignores empty slots", () => {
    const ordered = Array.from({ length: 9 }, (_, index) =>
      bot({ id: `bot-${index + 1}`, name: `Bot ${index + 1}` }),
    );

    expect(resolveRosterShortcutBot("thread.jump.1", ordered)?.id).toBe("bot-1");
    expect(resolveRosterShortcutBot("thread.jump.9", ordered)?.id).toBe("bot-9");
    expect(resolveRosterShortcutBot("thread.jump.9", ordered.slice(0, 8))).toBeNull();
    expect(resolveRosterShortcutBot("thread.next", ordered)).toBeNull();
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

describe("resolveAdjacentRosterBot", () => {
  const ordered = [
    bot({ id: "a", name: "A" }),
    bot({ id: "b", name: "B" }),
    bot({ id: "c", name: "C" }),
  ];

  it("steps through bots in shortcut order and wraps at the ends", () => {
    expect(resolveAdjacentRosterBot("thread.next", ordered, "a")?.id).toBe("b");
    expect(resolveAdjacentRosterBot("thread.previous", ordered, "b")?.id).toBe("a");
    expect(resolveAdjacentRosterBot("thread.next", ordered, "c")?.id).toBe("a");
    expect(resolveAdjacentRosterBot("thread.previous", ordered, "a")?.id).toBe("c");
  });

  it("starts from the ends when no bot is open", () => {
    expect(resolveAdjacentRosterBot("thread.next", ordered, null)?.id).toBe("a");
    expect(resolveAdjacentRosterBot("thread.previous", ordered, null)?.id).toBe("c");
  });

  it("ignores other commands and a roster with only the open bot", () => {
    expect(resolveAdjacentRosterBot("thread.jump.1", ordered, "a")).toBeNull();
    expect(resolveAdjacentRosterBot("thread.next", [ordered[0]!], "a")).toBeNull();
    expect(resolveAdjacentRosterBot("thread.next", [], null)).toBeNull();
  });
});
