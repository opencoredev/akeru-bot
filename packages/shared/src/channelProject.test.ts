import { BotId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { defaultProjectIdForBot, type ChannelProjectModel } from "./channelProject.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const SECOND_PROJECT_ID = ProjectId.make("project-2");
const BOT_ID = BotId.make("bot-1");

const model: ChannelProjectModel = {
  projects: [
    { id: PROJECT_ID, title: "Project", updatedAt: NOW, deletedAt: null },
    { id: SECOND_PROJECT_ID, title: "Second project", updatedAt: NOW, deletedAt: null },
  ],
  threads: [],
};

const thread = (input: {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly botId?: BotId;
  readonly updatedAt: string;
}) => ({
  id: ThreadId.make(input.id),
  projectId: input.projectId,
  botId: input.botId ?? BOT_ID,
  updatedAt: input.updatedAt,
  archivedAt: null,
});

describe("defaultProjectIdForBot", () => {
  it("resolves a bot's default project from its own recent chats before global activity", () => {
    const otherBot = BotId.make("other-bot");
    const withThreads: ChannelProjectModel = {
      ...model,
      threads: [
        thread({
          id: "bot-old",
          projectId: SECOND_PROJECT_ID,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        thread({
          id: "bot-new",
          projectId: PROJECT_ID,
          updatedAt: "2026-02-01T00:00:00.000Z",
        }),
        thread({
          id: "other",
          projectId: SECOND_PROJECT_ID,
          botId: otherBot,
          updatedAt: "2026-03-01T00:00:00.000Z",
        }),
      ],
    };
    expect(defaultProjectIdForBot(withThreads, BOT_ID)).toBe(PROJECT_ID);
    expect(defaultProjectIdForBot(withThreads, otherBot)).toBe(SECOND_PROJECT_ID);
    expect(defaultProjectIdForBot(withThreads, BotId.make("fresh-bot"))).toBe(SECOND_PROJECT_ID);
    expect(defaultProjectIdForBot({ ...model, threads: [] }, BOT_ID)).toBe(PROJECT_ID);
    expect(defaultProjectIdForBot({ projects: [], threads: [] }, BOT_ID)).toBeNull();
  });

  it("accepts a null bot and skips deleted projects", () => {
    const deletedFirst: ChannelProjectModel = {
      projects: [
        { id: PROJECT_ID, title: "Project", updatedAt: "2026-03-01T00:00:00.000Z", deletedAt: NOW },
        { id: SECOND_PROJECT_ID, title: "Second project", updatedAt: NOW, deletedAt: null },
      ],
      threads: [],
    };
    expect(defaultProjectIdForBot(deletedFirst, null)).toBe(SECOND_PROJECT_ID);
  });
});
