import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationBot, OrchestrationGroup } from "@t3tools/contracts";
import { resolveComposerBotMention } from "@t3tools/shared/composerBotMentions";

import {
  buildComposerMentionItems,
  composerMentionItemToken,
  groupMentionBots,
  isThreadMentionQuery,
} from "./composerMentionItems";

const threads = [
  { id: "thread-2", projectId: "project-1", title: "Release plan", archivedAt: null },
  {
    id: "thread-3",
    projectId: "project-1",
    title: "Release notes",
    archivedAt: "2026-09-01T00:00:00.000Z",
  },
  { id: "delegation-thread-4", projectId: "project-1", title: "Release work", archivedAt: null },
];

function build(query: string, browserAvailable = true) {
  return buildComposerMentionItems({
    query,
    browserAvailable,
    threads,
    currentThreadId: "thread-1",
    currentProjectId: "project-1",
    matchedIds: new Set(),
  });
}

describe("buildComposerMentionItems", () => {
  it("offers the browser first and only when browser access is on", () => {
    expect(build("").map((item) => item.type)).toEqual(["browser-mention", "thread-mention"]);
    expect(build("", false).map((item) => item.type)).toEqual(["thread-mention"]);
    expect(build("bro").map((item) => item.label)).toEqual(["Browser"]);
  });

  it("hides archived and background chats and keeps @chat: to chats", () => {
    expect(build("chat:rel").map((item) => item.label)).toEqual(["Release plan"]);
    expect(isThreadMentionQuery("Chat:x")).toBe(true);
    expect(isThreadMentionQuery("src/")).toBe(false);
  });

  it("keeps content-only chat matches out of a path-like query", () => {
    const items = buildComposerMentionItems({
      query: "src/comp",
      browserAvailable: false,
      threads,
      currentThreadId: "thread-1",
      currentProjectId: "project-1",
      matchedIds: new Set(["thread-2"]),
    });
    expect(items).toEqual([]);
    const byContent = buildComposerMentionItems({
      query: "comp",
      browserAvailable: false,
      threads,
      currentThreadId: "thread-1",
      currentProjectId: "project-1",
      matchedIds: new Set(["thread-2"]),
    });
    expect(byContent.map((item) => item.label)).toEqual(["Release plan"]);
  });
});

describe("bot mentions", () => {
  const bot = (id: string, name: string, title: string, archivedAt: string | null = null) =>
    ({ id, name, title, archivedAt }) as unknown as OrchestrationBot;
  const bots = [
    bot("bot-claude-1", "Mika", "Designer"),
    bot("bot-grok-2", "Mika", "Reviewer"),
    bot("bot-3", "Mori", "Writer"),
    bot("bot-4", "Mika", "Retired", "2026-09-01T00:00:00.000Z"),
    bot("bot-5", "Mika", "Outsider"),
  ];
  const group = {
    id: "group-1",
    members: ["bot-claude-1", "bot-grok-2", "bot-3", "bot-4"].map((botId) => ({
      kind: "bot",
      botId,
    })),
  } as unknown as OrchestrationGroup;
  const members = groupMentionBots(group, bots);

  it("offers only the group's active bots, and none in a direct chat", () => {
    expect(members.map((member) => member.id)).toEqual(["bot-claude-1", "bot-grok-2", "bot-3"]);
    expect(groupMentionBots(undefined, bots)).toEqual([]);
  });

  it("lists both bots named Mika and routes each row to its own id", () => {
    const items = buildComposerMentionItems({
      query: "mi",
      browserAvailable: true,
      bots: members,
      threads: [],
      currentThreadId: "thread-1",
      currentProjectId: "project-1",
      matchedIds: new Set(),
    });
    expect(items.map((item) => [item.type, item.label, item.description])).toEqual([
      ["bot-mention", "Mika", "Designer"],
      ["bot-mention", "Mika", "Reviewer"],
    ]);
    const routed = items.map((item) => {
      const text = `ask ${composerMentionItemToken(item)} to check`;
      return [text, resolveComposerBotMention(text, members)];
    });
    expect(routed).toEqual([
      ["ask @bot:bot-claude-1 to check", { kind: "bot", botId: "bot-claude-1" }],
      ["ask @bot:bot-grok-2 to check", { kind: "bot", botId: "bot-grok-2" }],
    ]);
  });

  it("marks a bot whose provider cannot take handed-off work", () => {
    const withEngine = (id: string, name: string, provider: string) =>
      ({
        id,
        name,
        title: "",
        archivedAt: null,
        engine: { provider, model: "m" },
      }) as unknown as OrchestrationBot;
    const engineBots = [
      withEngine("bot-claude-1", "Nova", "opencode"),
      withEngine("bot-grok-2", "Nia", "opencode_go"),
      withEngine("bot-3", "Nix", "missing"),
    ];
    const providers = [
      { instanceId: "opencode", driver: "opencode" },
      { instanceId: "opencode_go", driver: "opencodeGo" },
    ] as unknown as Parameters<typeof groupMentionBots>[2];
    const marked = groupMentionBots(group, engineBots, providers);
    expect(marked.map((member) => member.canTakeWork)).toEqual([false, true, true]);
    const items = buildComposerMentionItems({
      query: "n",
      browserAvailable: false,
      bots: marked,
      threads: [],
      currentThreadId: "thread-1",
      currentProjectId: "project-1",
      matchedIds: new Set(),
    });
    expect(items.map((item) => item.description)).toEqual([
      "Cannot take handed-off work",
      "Bot",
      "Bot",
    ]);
  });

  it("keeps bots out of an explicit @chat: query", () => {
    const items = buildComposerMentionItems({
      query: "chat:mi",
      browserAvailable: false,
      bots: members,
      threads: [],
      currentThreadId: "thread-1",
      currentProjectId: "project-1",
      matchedIds: new Set(),
    });
    expect(items).toEqual([]);
  });
});
