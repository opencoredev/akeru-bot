import {
  EnvironmentId,
  type OrchestrationBot,
  type OrchestrationGroup,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildArchivedChatSections } from "./ArchivedChatsSettings.logic";

const environmentId = EnvironmentId.make("env-1");

function thread(
  id: string,
  archivedAt: string,
  owner: { botId?: string; groupId?: string; parentThreadId?: string },
): OrchestrationThreadShell {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: archivedAt,
    archivedAt,
    ...owner,
  } as OrchestrationThreadShell;
}

function snapshot(
  threads: OrchestrationThreadShell[],
  extra: Partial<OrchestrationShellSnapshot> = {},
): OrchestrationShellSnapshot {
  return { threads, bots: [], groups: [], ...extra } as unknown as OrchestrationShellSnapshot;
}

const mori = { id: "bot-mori", name: "Mori" } as OrchestrationBot;
const akeru = { id: "bot-akeru", name: "Akeru" } as OrchestrationBot;
const crew = { id: "group-crew", name: "Crew" } as OrchestrationGroup;

describe("buildArchivedChatSections", () => {
  it("groups archived chats by bot or group, newest archive first", () => {
    const sections = buildArchivedChatSections({
      environmentId,
      snapshot: snapshot([
        thread("a", "2026-09-10T00:00:00.000Z", { botId: "bot-mori" }),
        thread("b", "2026-09-20T00:00:00.000Z", { botId: "bot-akeru" }),
        thread("c", "2026-09-15T00:00:00.000Z", { botId: "bot-mori" }),
        thread("d", "2026-09-12T00:00:00.000Z", { groupId: "group-crew", botId: "bot-mori" }),
      ]),
      bots: [mori, akeru],
      groups: [crew],
    });

    expect(sections.map((section) => [section.kind, section.name])).toEqual([
      ["bot", "Akeru"],
      ["bot", "Mori"],
      ["group", "Crew"],
    ]);
    expect(sections[1]?.chats.map((chat) => chat.threadId)).toEqual(["c", "a"]);
    expect(sections[0]?.chats[0]).toMatchObject({
      environmentId,
      threadId: "b",
      title: "Chat b",
      archivedAt: "2026-09-20T00:00:00.000Z",
    });
  });

  it("leaves out work handed to another bot", () => {
    const sections = buildArchivedChatSections({
      environmentId,
      snapshot: snapshot([
        thread("child", "2026-09-10T00:00:00.000Z", { botId: "bot-mori", parentThreadId: "p" }),
      ]),
      bots: [mori],
      groups: [],
    });

    expect(sections).toEqual([]);
  });

  it("names owners from the archived snapshot and keeps unknown owners visible", () => {
    const sections = buildArchivedChatSections({
      environmentId,
      snapshot: snapshot(
        [
          thread("a", "2026-09-10T00:00:00.000Z", { botId: "bot-old" }),
          thread("b", "2026-09-09T00:00:00.000Z", { botId: "bot-gone" }),
        ],
        { bots: [{ id: "bot-old", name: "Old bot" } as OrchestrationBot] },
      ),
      bots: [],
      groups: [],
    });

    expect(sections.map((section) => section.name)).toEqual(["Old bot", null]);
  });

  it("is empty until the archive loads", () => {
    expect(
      buildArchivedChatSections({ environmentId, snapshot: null, bots: [mori], groups: [] }),
    ).toEqual([]);
  });
});
