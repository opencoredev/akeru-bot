import { describe, expect, it } from "vite-plus/test";

import {
  applyBotPromptMention,
  botPromptMentionChips,
  botPromptMentionTrigger,
  botPromptThreadQuery,
  buildBotPromptMentionItems,
  removeBotPromptMention,
} from "./botPromptMentions.logic";

const bots = [{ id: "bot-1", name: "Mika" }];
const threads = [{ id: "thread-2", title: "Release plan" }];

describe("botPromptMentionTrigger", () => {
  it("opens for an @ token at the caret and stays closed otherwise", () => {
    expect(botPromptMentionTrigger("check @bro", 10)).toEqual({
      query: "bro",
      rangeStart: 6,
      rangeEnd: 10,
    });
    expect(botPromptMentionTrigger("check @", 7)?.query).toBe("");
    expect(botPromptMentionTrigger("check @chat:rel", 17)?.query).toBe("chat:rel");
    expect(botPromptMentionTrigger("check this", 10)).toBeNull();
    expect(botPromptMentionTrigger("use $skill", 10)).toBeNull();
    expect(botPromptMentionTrigger("/model", 6)).toBeNull();
    expect(botPromptMentionTrigger('open @"my file', 14)).toBeNull();
  });

  it("strips the thread prefix for chat matching", () => {
    expect(botPromptThreadQuery("chat:rel")).toBe("rel");
    expect(botPromptThreadQuery("rel")).toBe("rel");
  });
});

describe("buildBotPromptMentionItems", () => {
  it("offers the browser only when browser access is on", () => {
    const enabled = buildBotPromptMentionItems({
      query: "",
      browserAvailable: true,
      bots,
      threads,
    });
    expect(enabled.map((item) => item.kind)).toEqual(["browser", "bot", "thread"]);

    const gated = buildBotPromptMentionItems({ query: "", browserAvailable: false, bots, threads });
    expect(gated.some((item) => item.kind === "browser")).toBe(false);
  });

  it("finds the browser by its displayed name", () => {
    const items = buildBotPromptMentionItems({
      query: "浏览",
      browserAvailable: true,
      browserLabel: "浏览器",
      bots,
      threads,
    });
    expect(items[0]?.kind).toBe("browser");
  });

  it("filters by query and keeps @chat: to chats", () => {
    expect(
      buildBotPromptMentionItems({ query: "bro", browserAvailable: true, bots, threads: [] }),
    ).toEqual([{ kind: "browser", key: "browser", label: "Browser" }]);
    expect(
      buildBotPromptMentionItems({ query: "chat:", browserAvailable: true, bots, threads }).map(
        (item) => item.kind,
      ),
    ).toEqual(["thread"]);
  });

  it("carries whether each bot can take handed-off work", () => {
    const items = buildBotPromptMentionItems({
      query: "",
      browserAvailable: false,
      bots: [
        { id: "bot-1", name: "Mika" },
        { id: "bot-2", name: "Legacy", canTakeWork: false },
      ],
      threads: [],
    });
    expect(
      items.map((item) => (item.kind === "bot" ? [item.label, item.canTakeWork] : null)),
    ).toEqual([
      ["Mika", true],
      ["Legacy", false],
    ]);
  });

  it("matches bots by name prefix, like the browser", () => {
    const named = [
      { id: "bot-1", name: "Mika" },
      { id: "bot-2", name: "Tamika" },
    ];
    expect(
      buildBotPromptMentionItems({
        query: "mi",
        browserAvailable: false,
        bots: named,
        threads: [],
      }).map((item) => item.label),
    ).toEqual(["Mika"]);
  });

  it("gives a bot named browser its id token instead of the browser mention", () => {
    const [item] = buildBotPromptMentionItems({
      query: "brow",
      browserAvailable: false,
      bots: [{ id: "bot-browser", name: "browser" }],
      threads: [],
    });
    expect(item).toMatchObject({ kind: "bot" });
    expect(item && "source" in item ? item.source : null).not.toBe("@browser");
  });

  it("lists every bot that shares a name, told apart by title or short id", () => {
    const namesakes = [
      { id: "bot-claude-1", name: "Mika", title: "Designer" },
      { id: "bot-grok-2", name: "Mika", title: "Reviewer" },
      { id: "bot-3", name: "Mila", title: "Writer" },
    ];
    const items = buildBotPromptMentionItems({
      query: "mi",
      browserAvailable: false,
      bots: namesakes,
      threads: [],
    });
    expect(items.map((item) => (item.kind === "bot" ? [item.label, item.detail] : null))).toEqual([
      ["Mika", "Designer"],
      ["Mika", "Reviewer"],
      ["Mila", null],
    ]);

    const sameTitle = namesakes.map((bot) => ({ ...bot, title: "Designer" }));
    expect(
      buildBotPromptMentionItems({
        query: "mika",
        browserAvailable: false,
        bots: sameTitle,
        threads: [],
      }).map((item) => (item.kind === "bot" ? item.detail : null)),
    ).toEqual(["#aude-1", "#grok-2"]);
  });

  it("inserts an exact-bot token for a shared name and @Name otherwise", () => {
    const namesakes = [
      { id: "bot-1", name: "Mika", title: "Designer" },
      { id: "bot-2", name: "Mika", title: "Reviewer" },
      { id: "bot-3", name: "Mila" },
    ];
    const trigger = botPromptMentionTrigger("ask @mi", 7)!;
    const items = buildBotPromptMentionItems({
      query: trigger.query,
      browserAvailable: false,
      bots: namesakes,
      threads: [],
    });
    expect(items.map((item) => applyBotPromptMention("ask @mi", trigger, item).text)).toEqual([
      "ask @bot:bot-1 ",
      "ask @bot:bot-2 ",
      "ask @Mila ",
    ]);
  });

  it("lists workspace files after the mentions", () => {
    const items = buildBotPromptMentionItems({
      query: "re",
      browserAvailable: true,
      bots,
      threads,
      paths: [{ path: "docs/release.md" }],
    });
    expect(items.map((item) => item.kind)).toEqual(["thread", "path"]);
    expect(items[1]).toMatchObject({ label: "release.md", directory: "docs" });
  });

  it("puts the file first when a path query matches no mention by name", () => {
    // Chat search also matches message text, so a chat can rank for "src/comp".
    const contentMatch = [{ id: "thread-3", title: "Refactor review" }];
    const items = buildBotPromptMentionItems({
      query: "src/comp",
      browserAvailable: true,
      bots,
      threads: contentMatch,
      paths: [{ path: "src/components/App.tsx" }, { path: "src/compat.ts" }],
    });
    expect(items.map((item) => item.kind)).toEqual(["path", "path"]);

    const titled = buildBotPromptMentionItems({
      query: "v1.2",
      browserAvailable: true,
      bots,
      threads: [{ id: "thread-4", title: "Ship v1.2" }],
      paths: [],
    });
    expect(titled.map((item) => item.label)).toEqual(["Ship v1.2"]);
  });

  it("skips files for an explicit @chat: query", () => {
    expect(
      buildBotPromptMentionItems({
        query: "chat:src",
        browserAvailable: true,
        bots,
        threads,
        paths: [{ path: "src/a.ts" }],
      }).map((item) => item.kind),
    ).toEqual(["thread"]);
  });
});

describe("applyBotPromptMention", () => {
  it("replaces the typed query with the token and a trailing space", () => {
    const trigger = botPromptMentionTrigger("check @rel now", 10)!;
    const [thread] = buildBotPromptMentionItems({
      query: "rel",
      browserAvailable: false,
      bots: [],
      threads,
    });
    expect(applyBotPromptMention("check @rel now", trigger, thread!)).toEqual({
      text: "check @chat:thread-2 now",
      caret: 21,
    });

    const browserTrigger = botPromptMentionTrigger("@b", 2)!;
    expect(
      applyBotPromptMention("@b", browserTrigger, {
        kind: "browser",
        key: "browser",
        label: "Browser",
      }).text,
    ).toBe("@browser ");

    const pathTrigger = botPromptMentionTrigger("open @src/comp", 14)!;
    const [file] = buildBotPromptMentionItems({
      query: pathTrigger.query,
      browserAvailable: true,
      bots,
      threads: [],
      paths: [{ path: "src/components/App.tsx" }],
    });
    expect(applyBotPromptMention("open @src/comp", pathTrigger, file!).text).toBe(
      "open [App.tsx](src/components/App.tsx) ",
    );
  });
});

describe("botPromptMentionChips", () => {
  const title = (id: string) => (id === "thread-2" ? "Release plan" : null);

  it("labels each mention once and round trips through the plain-text draft", () => {
    const draft = "look @browser at @chat:thread-2 and @chat:thread-2 plus @chat:gone";
    const chips = botPromptMentionChips(draft, title);
    expect(chips.map((chip) => [chip.kind, chip.label])).toEqual([
      ["browser", "Browser"],
      ["thread", "Release plan"],
      ["thread", "Unknown chat"],
    ]);
    // The draft store keeps the text, so restoring it yields the same chips.
    expect(botPromptMentionChips(String(draft), title)).toEqual(chips);
  });

  it("labels an exact-bot mention with the bot's name", () => {
    const name = (id: string) => (id === "bot-2" ? "Mika" : null);
    const chips = botPromptMentionChips("ask @bot:bot-2 and @bot:gone ", title, name);
    expect(chips.map((chip) => [chip.key, chip.label])).toEqual([
      ["bot:bot-2", "Mika"],
      ["bot:gone", "Unknown bot"],
    ]);
    expect(removeBotPromptMention("ask @bot:bot-2 now", chips[0]!)).toBe("ask now");
  });

  it("removes every copy of a chip's mention", () => {
    const draft = "look @chat:thread-2 and @chat:thread-2 now";
    const [chip] = botPromptMentionChips(draft, title);
    expect(removeBotPromptMention(draft, chip!)).toBe("look and now");
  });
});
