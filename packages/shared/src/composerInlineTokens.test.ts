import { describe, expect, it } from "vite-plus/test";

import {
  collectComposerInlineTokens,
  collectComposerMentionDisplays,
  collectComposerMentionReferences,
  serializeComposerBotMention,
  serializeComposerThreadMention,
} from "./composerInlineTokens.ts";

describe("collectComposerInlineTokens", () => {
  it("collects file links, mentions, and skills with source ranges", () => {
    const text = "Use $ui and inspect [Chat.tsx](src/Chat.tsx) with @AGENTS.md please";

    expect(collectComposerInlineTokens(text)).toEqual([
      {
        type: "skill",
        value: "ui",
        source: "$ui",
        start: 4,
        end: 7,
      },
      {
        type: "mention",
        value: "src/Chat.tsx",
        source: "[Chat.tsx](src/Chat.tsx)",
        start: 20,
        end: 44,
      },
      {
        type: "mention",
        value: "AGENTS.md",
        source: "@AGENTS.md",
        start: 50,
        end: 60,
      },
    ]);
  });

  it("collects numeric-leading skill names", () => {
    expect(collectComposerInlineTokens("Use $123-review now")).toEqual([
      {
        type: "skill",
        value: "123-review",
        source: "$123-review",
        start: 4,
        end: 15,
      },
    ]);
  });

  it("does not convert incomplete trailing tokens", () => {
    expect(collectComposerInlineTokens("Use $ui")).toEqual([]);
    expect(collectComposerInlineTokens("Inspect @AGENTS.md")).toEqual([]);
  });

  it("keeps the delimiter after a token outside its source range", () => {
    const text = "Inspect [package.json](package.json) next";

    expect(collectComposerInlineTokens(text)).toEqual([
      {
        type: "mention",
        value: "package.json",
        source: "[package.json](package.json)",
        start: 8,
        end: 36,
      },
    ]);
    expect(text.slice(36)).toBe(" next");
  });

  it("preserves a confirmed pill when only its trailing delimiter is removed", () => {
    const withDelimiter = "[package.json](package.json) ";
    const confirmed = collectComposerInlineTokens(withDelimiter);

    expect(
      collectComposerInlineTokens(withDelimiter.trimEnd(), { preserveTrailingFrom: confirmed }),
    ).toEqual([
      {
        type: "mention",
        value: "package.json",
        source: "[package.json](package.json)",
        start: 0,
        end: 28,
      },
    ]);
  });

  it("preserves a bot mention as a separate token type", () => {
    const text = "@Pathfinder";

    expect(
      collectComposerInlineTokens(text, {
        preserveTrailingFrom: [
          {
            type: "bot-mention",
            value: "bot-pathfinder",
            source: text,
            start: 0,
            end: text.length,
          },
        ],
      }),
    ).toEqual([
      {
        type: "bot-mention",
        value: "bot-pathfinder",
        source: text,
        start: 0,
        end: text.length,
      },
    ]);
  });

  it("does not preserve a pill after its source is edited", () => {
    const confirmed = collectComposerInlineTokens("[package.json](package.json) ");

    expect(
      collectComposerInlineTokens("[package.json](package-json)", {
        preserveTrailingFrom: confirmed,
      }),
    ).toEqual([]);
  });

  it("ignores normal web links", () => {
    expect(collectComposerInlineTokens("Read [docs](https://example.com) first")).toEqual([]);
  });

  it.each(["@expo/ui", "@jane/foo.js", "@scope/pkg/sub/path"])(
    "keeps scoped package reference %s as plain text",
    (reference) => {
      expect(collectComposerInlineTokens(`Install ${reference} next`)).toEqual([]);
    },
  );

  it("keeps scoped package references plain across incomplete input and IME whitespace", () => {
    expect(collectComposerInlineTokens("Install @expo/ui")).toEqual([]);
    expect(collectComposerInlineTokens("入力 @expo/ui　を追加")).toEqual([]);
  });

  it("keeps bare non-scoped file paths as mentions", () => {
    expect(collectComposerInlineTokens("Inspect @README.md next")).toEqual([
      {
        type: "mention",
        value: "README.md",
        source: "@README.md",
        start: 8,
        end: 18,
      },
    ]);
  });

  it("keeps canonical file links for scoped paths as mentions", () => {
    expect(collectComposerInlineTokens("Inspect [sub](@scope/pkg/sub) next")).toEqual([
      {
        type: "mention",
        value: "@scope/pkg/sub",
        source: "[sub](@scope/pkg/sub)",
        start: 8,
        end: 29,
      },
    ]);
  });

  it("allows ambiguous scoped paths through explicit quoted mentions", () => {
    expect(collectComposerInlineTokens('Inspect @"expo/ui" next')).toEqual([
      {
        type: "mention",
        value: "expo/ui",
        source: '@"expo/ui"',
        start: 8,
        end: 18,
      },
    ]);
  });

  it("still collects a file link whose label is at the length cap", () => {
    const label = `${"a".repeat(508)}.tsx`;
    const tokens = collectComposerInlineTokens(`see [${label}](src/${label}) ok`);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.value).toBe(`src/${label}`);
  });

  it("leaves a file link past the label cap as plain text", () => {
    const label = `${"a".repeat(509)}.tsx`;
    expect(collectComposerInlineTokens(`see [${label}](src/${label}) ok`)).toEqual([]);
  });

  it("stays fast on unterminated bracket runs", () => {
    // Unbounded, the label body rescanned the rest of the text from every
    // whitespace: this input took seconds.
    const started = performance.now();
    expect(collectComposerInlineTokens(" [[".repeat(40_000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("composer mention tokens", () => {
  it("parses @browser and @chat: mentions instead of path mentions", () => {
    expect(collectComposerInlineTokens("Use @browser and @chat:abc-123 please")).toEqual([
      { type: "browser-mention", value: "browser", source: "@browser", start: 4, end: 12 },
      {
        type: "thread-mention",
        value: "abc-123",
        source: "@chat:abc-123",
        start: 17,
        end: 30,
      },
    ]);
  });

  it("keeps quoted browser paths as file mentions", () => {
    expect(collectComposerInlineTokens('Open @"browser" now')).toEqual([
      { type: "mention", value: "browser", source: '@"browser"', start: 5, end: 15 },
    ]);
  });

  it("round trips a thread mention through serialization", () => {
    const token = serializeComposerThreadMention("thread-9f");
    expect(token).toBe("@chat:thread-9f");
    expect(collectComposerMentionReferences(`see ${token}`)).toEqual({
      browser: false,
      threadIds: ["thread-9f"],
    });
    expect(serializeComposerThreadMention("bad id")).toBeNull();
  });

  it("collects trailing and repeated references once", () => {
    expect(collectComposerMentionReferences("@chat:a @browser @chat:a @chat:b @browser")).toEqual({
      browser: true,
      threadIds: ["a", "b"],
    });
    expect(collectComposerMentionReferences("@browsers @chats")).toEqual({
      browser: false,
      threadIds: [],
    });
  });

  it("parses @bot:<id> as a bot mention and labels it by name", () => {
    const token = serializeComposerBotMention("bot-2");
    expect(token).toBe("@bot:bot-2");
    expect(collectComposerInlineTokens(`ask ${token} now`)).toEqual([
      { type: "bot-mention", value: "bot-2", source: "@bot:bot-2", start: 4, end: 14 },
    ]);
    expect(serializeComposerBotMention("bad id")).toBeNull();
    const name = (id: string) => (id === "bot-2" ? "Mika" : null);
    expect(
      collectComposerMentionDisplays("@bot:bot-2 and @bot:gone", () => null, name).map(
        (display) => [display.kind, display.label, display.botId],
      ),
    ).toEqual([
      ["bot", "Mika", "bot-2"],
      ["bot", "Unknown bot", "gone"],
    ]);
  });
});
