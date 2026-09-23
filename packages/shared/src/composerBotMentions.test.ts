import { describe, expect, it } from "vite-plus/test";

import { composerBotMentionDetail, resolveComposerBotMention } from "./composerBotMentions.ts";

const namesakes = [
  { id: "bot-1", name: "Mika" },
  { id: "bot-2", name: "Mika" },
  { id: "bot-3", name: "Mori" },
];

describe("resolveComposerBotMention", () => {
  it("routes the latest whole-word name", () => {
    expect(resolveComposerBotMention("@Mori then @Mika", namesakes.slice(1))).toEqual({
      kind: "bot",
      botId: "bot-2",
    });
    expect(resolveComposerBotMention("mail @Morisson", namesakes)).toEqual({ kind: "none" });
  });

  it("calls a bare shared name ambiguous", () => {
    expect(resolveComposerBotMention("hey @Mika", namesakes)).toEqual({
      kind: "ambiguous",
      name: "Mika",
    });
  });

  it("routes an id token to that exact bot, even when its name is shared", () => {
    expect(resolveComposerBotMention("hey @bot:bot-2 look", namesakes)).toEqual({
      kind: "bot",
      botId: "bot-2",
    });
    expect(resolveComposerBotMention("@Mori, ask @bot:bot-1", namesakes)).toEqual({
      kind: "bot",
      botId: "bot-1",
    });
    expect(resolveComposerBotMention("@bot:bot-1 then @Mori", namesakes)).toEqual({
      kind: "bot",
      botId: "bot-3",
    });
  });

  it("ignores an id token for a bot outside the list", () => {
    expect(resolveComposerBotMention("@bot:bot-9", namesakes)).toEqual({ kind: "none" });
  });
});

describe("composerBotMentionDetail", () => {
  it("tells two bots named Mika apart by title, then by short id", () => {
    const titled = [
      { id: "bot-claude-1", name: "Mika", title: "Designer" },
      { id: "bot-grok-2", name: "Mika", title: "Reviewer" },
      { id: "bot-3", name: "Mila", title: "Writer" },
    ];
    expect(titled.map((bot) => composerBotMentionDetail(bot, titled))).toEqual([
      "Designer",
      "Reviewer",
      null,
    ]);
    const sameTitle = titled.map((bot) => ({ ...bot, title: "Designer" }));
    expect(sameTitle.map((bot) => composerBotMentionDetail(bot, sameTitle))).toEqual([
      "#aude-1",
      "#grok-2",
      null,
    ]);
  });
});
