import { BotId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archivedRosterBots,
  botAvatarSeed,
  buildGroupedRosterSections,
  buildRosterSections,
  buildRosterStrip,
  buildRosterTiles,
  filterRosterBots,
  filterRosterGroups,
  DEFAULT_BLOB_COLOR,
  DEFAULT_BLOB_SHAPE,
  formatRosterTimestamp,
  isRecordableChatPath,
  orderRosterBotsForShortcuts,
  parseChatPath,
  randomBotAvatar,
  resolveBlobRendering,
  resolveBlobColor,
  resolveBlobEyes,
  resolveBlobOutline,
  resolveBotPresence,
  flattenMarkdownPreview,
  resolveLatestRosterMessage,
  resolveRosterBotId,
  resolveRosterIndicator,
  resolveAdjacentRosterBot,
  resolveRosterShortcutBot,
  parseRosterBotDragId,
  parseRosterGroupDropId,
  planRosterDrop,
  planRosterSectionDrop,
  moveRosterItemInOrder,
  rosterItemsForZone,
  buildRosterListItems,
  resolveRosterDropTarget,
  rosterBotDragId,
  rosterEntryId,
  rosterGroupDropId,
  rosterMarkerId,
  rosterZoneHasVisibleEntries,
  rosterZoneHeading,
  BLOB_COLORS,
  BLOB_SHAPES,
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

describe("resolveBlobEyes", () => {
  it("cuts eyes out of every preset", () => {
    for (const color of BLOB_COLORS) {
      expect(resolveBlobEyes(color)).toEqual({ kind: "cutout" });
    }
  });

  it("paints eyes on bodies too light or too dark for a cutout to read", () => {
    expect(resolveBlobEyes("#FFFFFF")).toEqual({ kind: "ink", ink: "#161616" });
    expect(resolveBlobEyes("#FFF4B0")).toEqual({ kind: "ink", ink: "#161616" });
    expect(resolveBlobEyes("#000000")).toEqual({ kind: "ink", ink: "#FFFFFF" });
  });
});

describe("resolveBlobColor", () => {
  it("moves retired muted presets onto the vivid palette", () => {
    expect(resolveBlobColor("#E0645C")).toBe("#FF4A5A");
    expect(resolveBlobColor("#7a8699")).toBe("#8E8E93");
  });

  it("keeps custom colors and falls back for invalid ones", () => {
    expect(resolveBlobColor("#123abc")).toBe("#123ABC");
    expect(resolveBlobColor("#FFFFFF")).toBe("#FFFFFF");
    expect(resolveBlobColor("")).toBe(DEFAULT_BLOB_COLOR);
    expect(resolveBlobColor("red")).toBe(DEFAULT_BLOB_COLOR);
  });
});

describe("resolveBlobOutline", () => {
  it("outlines only bodies light enough to fade into a light surface", () => {
    expect(resolveBlobOutline("#FFFFFF")).not.toBeNull();
    for (const color of [...BLOB_COLORS, "#000000", "nope"]) {
      expect(resolveBlobOutline(color)).toBeNull();
    }
  });
});

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
  it("returns a valid blob from the presets", () => {
    for (let i = 0; i < 20; i++) {
      const avatar = randomBotAvatar(() => i / 20);
      expect(avatar.kind).toBe("blob");
      if (avatar.kind !== "blob") continue;
      expect(BLOB_SHAPES).toContain(avatar.shape);
      expect(BLOB_COLORS).toContain(avatar.color);
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

describe("flattenMarkdownPreview with raw HTML", () => {
  it("shows the text HTML renders, not its tags", () => {
    expect(flattenMarkdownPreview("<b>Done</b> and <i>shipped</i>")).toBe("Done and shipped");
    expect(flattenMarkdownPreview("First<br>second")).toBe("First second");
    expect(flattenMarkdownPreview("<div>Tom &amp; Jerry &#8217;s &#x1F680; &bogus;</div>")).toBe(
      "Tom & Jerry \u2019s \u{1F680} &bogus;",
    );
    expect(
      flattenMarkdownPreview("<div>Copyright &copy; 2026 *not* 1. [x] \\ &hellip;</div>"),
    ).toBe("Copyright \u00a9 2026 *not* 1. [x] \\ \u2026");
    expect(flattenMarkdownPreview("<div>\nBlock\n</div>\n\nAfter <!-- note -->")).toBe(
      "Block After",
    );
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

  it("ignores a newer fallback sent to another chat", () => {
    const answer = messages([
      { role: "assistant", text: "Yesterday", at: "2026-08-20T10:00:00.000Z" },
    ]);
    const fallback = { text: "Today", at: "2026-08-20T12:00:00.000Z", threadId: "chat-b" };
    expect(resolveLatestRosterMessage(fallback, answer, "chat-a")).toEqual({
      text: "Yesterday",
      at: "2026-08-20T10:00:00.000Z",
    });
    expect(resolveLatestRosterMessage(fallback, answer, "chat-b")).toMatchObject({
      text: "Today",
    });
  });

  it("drops the fallback once the bot has no open chat", () => {
    const at = "2026-08-20T12:00:00.000Z";
    expect(resolveLatestRosterMessage({ text: "Ship it", at, threadId: "chat-a" }, [], null)).toBe(
      null,
    );
    expect(resolveLatestRosterMessage({ text: "Ship it", at }, [], null)).toBeNull();
  });

  it("flattens markdown and skips messages that flatten to nothing", () => {
    expect(
      resolveLatestRosterMessage(
        { text: "**Handoff** note", at: "2026-08-20T10:00:00.000Z" },
        messages([
          { role: "assistant", text: "Q3 came to **$1,200**", at: "2026-08-20T10:01:00.000Z" },
          { role: "assistant", text: "![chart](chart.png)", at: "2026-08-20T10:02:00.000Z" },
        ]),
      ),
    ).toEqual({ text: "Q3 came to $1,200", at: "2026-08-20T10:01:00.000Z" });
    expect(resolveLatestRosterMessage({ text: "**Handoff** note", at: "x" }, [])).toEqual({
      text: "Handoff note",
      at: "x",
    });
  });

  it("ignores a newer fallback that flattens to empty and keeps the older answer", () => {
    expect(
      resolveLatestRosterMessage(
        { text: "![chart](chart.png)", at: "2026-08-20T10:05:00.000Z" },
        messages([{ role: "assistant", text: "Older answer", at: "2026-08-20T10:02:00.000Z" }]),
      ),
    ).toEqual({ text: "Older answer", at: "2026-08-20T10:02:00.000Z" });
    expect(resolveLatestRosterMessage({ text: "![chart](chart.png)", at: "x" }, [])).toBeNull();
  });

  it("ignores messages from parent-linked child threads", () => {
    expect(
      resolveLatestRosterMessage(
        { text: "Own conversation", at: "2026-08-20T10:00:00.000Z" },
        messages([
          { role: "assistant", text: "Delegated task", at: "2026-08-20T10:05:00.000Z" },
        ]).map((message) => ({ ...message, parentThreadId: "parent-thread" })),
      ),
    ).toEqual({ text: "Own conversation", at: "2026-08-20T10:00:00.000Z" });
  });
});

describe("flattenMarkdownPreview", () => {
  it("strips emphasis, code, and strikethrough but keeps the words", () => {
    expect(
      flattenMarkdownPreview("**September at Akeru** was _busy_, *very* ~~slow~~ `fast`"),
    ).toBe("September at Akeru was busy, very slow fast");
  });

  it("keeps link labels and drops images", () => {
    expect(
      flattenMarkdownPreview(
        "See [the report](https://example.com/r) ![chart](chart.png) and <https://akeru.dev>",
      ),
    ).toBe("See the report and https://akeru.dev");
  });

  it("drops headings, list and quote markers, fences, and rules onto one line", () => {
    expect(
      flattenMarkdownPreview(
        [
          "## Summary",
          "> Quoted note",
          "- first",
          "* [x] second",
          "1. third",
          "---",
          "```ts",
          "const total = 1;",
          "```",
        ].join("\n"),
      ),
    ).toBe("Summary Quoted note first second third const total = 1;");
  });

  it("leaves snake_case identifiers and lone symbols alone", () => {
    expect(flattenMarkdownPreview("rename user_id to 2 * 3 = 6")).toBe(
      "rename user_id to 2 * 3 = 6",
    );
  });

  it("keeps asterisks inside code spans and URLs literal", () => {
    expect(flattenMarkdownPreview("`a*b*c` stays literal")).toBe("a*b*c stays literal");
    expect(flattenMarkdownPreview("see https://example.com/a*b*c and _em_")).toBe(
      "see https://example.com/a*b*c and em",
    );
    expect(flattenMarkdownPreview("mail <mailto:a*b@c.example> here")).toBe(
      "mail mailto:a*b@c.example here",
    );
  });

  it("never confuses literal text with internal markers", () => {
    expect(flattenMarkdownPreview("marker \u00010\u0001 stays")).toBe("marker \u00010\u0001 stays");
    expect(flattenMarkdownPreview("`code` then \u00010\u0001")).toBe("code then \u00010\u0001");
  });

  it("keeps link and image syntax inside code spans literal", () => {
    expect(flattenMarkdownPreview("`[docs](https://example.com)`")).toBe(
      "[docs](https://example.com)",
    );
    expect(flattenMarkdownPreview("`![chart](chart.png)`")).toBe("![chart](chart.png)");
  });

  it("drops emphasis around a bare URL", () => {
    expect(flattenMarkdownPreview("**https://example.com**")).toBe("https://example.com");
    expect(flattenMarkdownPreview("see _https://example.com/a_b_ now")).toBe(
      "see https://example.com/a_b now",
    );
  });

  it("previews a long answer from its opening lines", () => {
    const opening = "**Done.** Updated the [report](https://example.com/r).";
    expect(flattenMarkdownPreview(`${opening}\n\n${"- more detail\n".repeat(500)}`)).toMatch(
      /^Done\. Updated the report\. more detail/,
    );
    expect(flattenMarkdownPreview(`${"![shot](a.png)\n".repeat(100)}\nfinally words`)).toBe(
      "finally words",
    );
  });

  it("never cuts a long message inside link, image, or code syntax", () => {
    const alt = "long alt text ".repeat(55);
    expect(flattenMarkdownPreview(`Intro ![${alt}](chart.png) then answer`)).toBe(
      "Intro then answer",
    );
    const label = "label ".repeat(120);
    expect(flattenMarkdownPreview(`See [${label}](https://example.com) now`)).toBe(
      `See ${label.trim()} now`,
    );
    const code = "x ".repeat(400);
    expect(flattenMarkdownPreview(`\`${code}\` done`)).toBe(`${code.trim()} done`);
    const fenced = `\`\`\`\n${"line\n\n".repeat(200)}\`\`\`\n\n**after**`;
    expect(flattenMarkdownPreview(fenced)).not.toContain("`");
    // A long alt text with a line break once put the old cut inside the image.
    const wrapped = `Intro ![${"alt ".repeat(4_100)}\ncontinued](chart.png) then answer`;
    expect(flattenMarkdownPreview(wrapped)).toBe("Intro then answer");
  });

  it("previews one enormous line without parsing all of it", () => {
    const alt = "alt ".repeat(10_000);
    const line = `Intro **bold** \`code\` [label](https://example.com) ![${alt}](chart.png) then answer`;
    expect(flattenMarkdownPreview(line)).toBe("Intro bold code label");
    const words = `**Start** ${"word ".repeat(10_000)}`;
    const preview = flattenMarkdownPreview(words);
    expect(preview).toMatch(/^Start word word/);
    expect(preview.length).toBeLessThanOrEqual(2_000);
    expect(flattenMarkdownPreview(`Opening paragraph.\n\n${line}`)).toBe("Opening paragraph.");
    expect(
      flattenMarkdownPreview(`Example \`![literal](chart.png)\` ${"word ".repeat(10_000)}`),
    ).toMatch(/^Example !\[literal\]\(chart\.png\) word/);
  });

  it("drops nested and escaped image alt text in the rough preview", () => {
    const tail = "z".repeat(20_000);
    const nested = flattenMarkdownPreview(
      `Intro ![public [x] SECRET](chart.png) then answer${tail}`,
    );
    expect(nested).toMatch(/^Intro then answerz/);
    expect(nested).not.toContain("SECRET");
    const escaped = flattenMarkdownPreview(
      `Intro ![public \\] SECRET](chart.png) then answer${tail}`,
    );
    expect(escaped).toMatch(/^Intro then answerz/);
    expect(escaped).not.toContain("SECRET");
    // With no balanced close in the window, the rest of the window goes.
    expect(flattenMarkdownPreview(`Intro ![open [SECRET ${tail}`)).toBe("Intro");
    expect(flattenMarkdownPreview(`Intro ![alt](chart.png (SECRET ${tail}`)).toBe("Intro");
  });

  it("bounds the rough preview to a prefix of the message", () => {
    // Leading whitespace counts against the window instead of being scanned.
    expect(flattenMarkdownPreview(`${" ".repeat(30_000)}word`)).toBe("");
    expect(flattenMarkdownPreview(`${" ".repeat(1_990)}word ${"z".repeat(20_000)}`)).toBe(
      `word ${"z".repeat(5)}`,
    );
  });

  it("flattens whitespace-heavy messages", () => {
    // Line prefixes use [ \t], not \s, so no multiline pattern crosses a
    // newline and rescans the blank lines after it. This checks the output
    // only; a wall-clock bound would be flaky on a loaded runner.
    expect(flattenMarkdownPreview(`${"\n".repeat(20_000)}done`)).toBe("done");
    expect(flattenMarkdownPreview(`${"\n \t\n".repeat(5_000)}- item\n\n> quote`)).toBe(
      "item quote",
    );
  });
});

describe("resolveBlobRendering", () => {
  it("passes a valid blob avatar through", () => {
    expect(resolveBlobRendering({ kind: "blob", shape: "hex", color: "#16C47A" })).toEqual({
      shape: "hex",
      color: "#16C47A",
    });
  });

  it("draws legacy dither avatars as a stable blob picked from the seed", () => {
    const first = resolveBlobRendering({ kind: "dither", seed: "bot-a" });
    expect(resolveBlobRendering({ kind: "dither", seed: "bot-a" })).toEqual(first);
    expect(BLOB_SHAPES).toContain(first.shape);
    expect(BLOB_COLORS).toContain(first.color);
    const looks = new Set(
      ["bot-a", "bot-b", "bot-c", "bot-d", "bot-e"].map((seed) =>
        JSON.stringify(resolveBlobRendering({ kind: "dither", seed })),
      ),
    );
    expect(looks.size).toBeGreaterThan(1);
  });

  it("falls back to the default blob for images and missing avatars", () => {
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

describe("botAvatarSeed", () => {
  it("is a stable seed between 0 and 1", () => {
    expect(botAvatarSeed("Akeru")).toBe(botAvatarSeed("Akeru"));
    expect(botAvatarSeed("Akeru")).toBeGreaterThanOrEqual(0);
    expect(botAvatarSeed("Akeru")).toBeLessThan(1);
  });

  it("staggers different bots", () => {
    expect(botAvatarSeed("Akeru")).not.toBe(botAvatarSeed("Mori"));
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

describe("roster drag drop planning", () => {
  const akeru = { kind: "bot" as const, id: "akeru" };
  const mori = { kind: "bot" as const, id: "mori" };
  const crew = { kind: "group" as const, id: "crew" };

  const items = buildRosterListItems({
    pinnedItems: [akeru],
    sections: [{ id: "news", name: "News", items: [crew], collapsed: false }],
    unassignedItems: [mori],
  });

  it("builds pinned, named-section, and unassigned targets including empty placeholders", () => {
    expect(items.map((item) => (item.kind === "marker" ? item.marker : item.item.id))).toEqual([
      "pinned-header",
      "akeru",
      "pinned-divider",
      { kind: "section-header", sectionId: "news" },
      { kind: "section-placeholder", sectionId: "news" },
      "crew",
      "unassigned-header",
      "unassigned-placeholder",
      "mori",
    ]);
  });

  it("pins an unassigned bot dropped on the Pins label", () => {
    const target = resolveRosterDropTarget(
      items,
      rosterEntryId(mori),
      rosterMarkerId("pinned-header"),
      "news",
    );
    expect(target?.zone).toBe("pinned");
    expect(target?.order).toEqual([mori, akeru]);
    expect(
      planRosterDrop({
        activeId: rosterEntryId(mori),
        from: "unassigned",
        target: target!,
        pinnedOrder: [akeru],
      }),
    ).toEqual({ kind: "pin", item: mori, order: [mori, akeru] });
  });

  it("unpins a bot dropped into Unassigned and keeps the named section as a move", () => {
    const unpin = resolveRosterDropTarget(
      items,
      rosterEntryId(akeru),
      rosterMarkerId("unassigned-placeholder"),
      "news",
    );
    expect(unpin?.zone).toBe("unassigned");
    expect(
      planRosterDrop({
        activeId: rosterEntryId(akeru),
        from: "pinned",
        target: unpin!,
        pinnedOrder: [akeru],
      }),
    ).toEqual({
      kind: "move",
      item: akeru,
      zone: "unassigned",
      order: [akeru, mori],
      unpin: true,
    });
  });

  it("keeps a collapsed or emptied section droppable after its last item leaves", () => {
    const onlyCrew = buildRosterListItems({
      pinnedItems: [],
      sections: [{ id: "news", name: "News", items: [crew], collapsed: false }],
      unassignedItems: [],
    });
    expect(rosterZoneHasVisibleEntries(onlyCrew, { sectionId: "news" }, crew)).toBe(false);
    const target = resolveRosterDropTarget(
      onlyCrew,
      rosterEntryId(crew),
      rosterMarkerId({ kind: "section-placeholder", sectionId: "news" }),
      "news",
    );
    expect(target?.zone).toEqual({ sectionId: "news" });
    expect(target?.order).toEqual([crew]);
  });

  it("reorders named sections onto Unassigned without touching group membership", () => {
    expect(
      planRosterSectionDrop({
        sectionIds: ["news", "ops"],
        activeSectionId: "news",
        overId: rosterMarkerId("unassigned-header"),
      }),
    ).toEqual({ kind: "reorder-section", fromIndex: 0, toIndex: 1 });
  });

  it("does not plan a no-op pin reorder", () => {
    const target = resolveRosterDropTarget(
      items,
      rosterEntryId(akeru),
      rosterEntryId(akeru),
      "news",
    );
    expect(
      planRosterDrop({
        activeId: rosterEntryId(akeru),
        from: "pinned",
        target: target!,
        pinnedOrder: [akeru],
      }).kind,
    ).toBe("none");
  });

  it("nudges an item one slot without wrapping past the ends", () => {
    const order = [akeru, mori, crew];
    expect(moveRosterItemInOrder(order, mori, -1)?.map((item) => item.id)).toEqual([
      "mori",
      "akeru",
      "crew",
    ]);
    expect(moveRosterItemInOrder(order, akeru, -1)).toBeNull();
    expect(moveRosterItemInOrder(order, crew, 1)).toBeNull();
  });

  it("resolves the visible order for each roster zone", () => {
    const layout = {
      pinnedItems: [akeru],
      sections: [{ id: "news", items: [mori] }],
      unassignedItems: [crew],
    };
    expect(rosterItemsForZone("pinned", layout)).toEqual([akeru]);
    expect(rosterItemsForZone("unassigned", layout)).toEqual([crew]);
    expect(rosterItemsForZone({ sectionId: "news" }, layout)).toEqual([mori]);
    expect(rosterItemsForZone({ sectionId: "missing" }, layout)).toEqual([]);
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
