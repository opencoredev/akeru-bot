import { Schema } from "effect";
import {
  BotId,
  GroupId,
  ProviderInstanceId,
  ServerProvider,
  type ModelCapabilities,
  type OrchestrationBot,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeMobileBot, makeMobileServerConfig } from "../lib/mobile-fixtures.test-support";
import {
  effectiveThreadModelSelection,
  threadBotEngineUpdate,
  threadEngineBot,
} from "./thread-bot-engine";

const codex = ProviderInstanceId.make("codex");

function bot(overrides: Partial<OrchestrationBot> = {}): OrchestrationBot {
  return makeMobileBot({
    id: BotId.make("bot-1"),
    name: "Mira",
    archivedAt: null,
    engine: {
      provider: "codex",
      model: "gpt-a",
      options: [{ id: "reasoningEffort", value: "minimal" }],
    },
    ...overrides,
  });
}

const reasoning: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      currentValue: "default",
      options: [
        { id: "default", label: "Provider default", isDefault: true },
        { id: "minimal", label: "Minimal" },
        { id: "high", label: "High" },
      ],
    },
  ],
};

const config = makeMobileServerConfig({
  providers: [
    Schema.decodeUnknownSync(ServerProvider)({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00Z",
      slashCommands: [],
      skills: [],
      models: [
        { slug: "gpt-a", name: "A", isCustom: false, capabilities: reasoning },
        { slug: "gpt-custom", name: "Custom", isCustom: true, capabilities: null },
      ],
    }),
  ],
});

describe("thread bot engine", () => {
  it("targets the live bot of a direct chat", () => {
    const mira = bot();

    expect(threadEngineBot({ botId: mira.id, groupId: null }, [mira])).toBe(mira);
  });

  it("never targets a bot from a group, plain, or archived chat", () => {
    const mira = bot();

    expect(
      threadEngineBot({ botId: mira.id, groupId: GroupId.make("group-1") }, [mira]),
    ).toBeNull();
    expect(threadEngineBot({ botId: null, groupId: null }, [mira])).toBeNull();
    expect(
      threadEngineBot({ botId: mira.id }, [bot({ archivedAt: "2026-01-02T00:00:00Z" })]),
    ).toBeNull();
  });

  it("shows and sends the bot's engine over a stale draft", () => {
    const draftSelection = { instanceId: codex, model: "gpt-old" };
    const threadSelection = { instanceId: codex, model: "gpt-thread" };

    expect(effectiveThreadModelSelection({ bot: bot(), draftSelection, threadSelection })).toEqual({
      instanceId: codex,
      model: "gpt-a",
      options: [{ id: "reasoningEffort", value: "minimal" }],
    });
    expect(
      effectiveThreadModelSelection({
        bot: bot({ engine: null }),
        draftSelection,
        threadSelection,
      }),
    ).toBe(draftSelection);
    expect(
      effectiveThreadModelSelection({ bot: null, draftSelection: null, threadSelection }),
    ).toBe(threadSelection);
  });

  it("saves a model and its options to the bot in one engine", () => {
    expect(
      threadBotEngineUpdate(config, {
        instanceId: codex,
        model: "gpt-a",
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-a",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("drops a provider default and keeps options on a model with unknown capabilities", () => {
    expect(
      threadBotEngineUpdate(config, {
        instanceId: codex,
        model: "gpt-a",
        options: [{ id: "reasoningEffort", value: "default" }],
      }),
    ).toEqual({ provider: "codex", model: "gpt-a" });
    expect(
      threadBotEngineUpdate(config, {
        instanceId: codex,
        model: "gpt-custom",
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-custom",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });
});
