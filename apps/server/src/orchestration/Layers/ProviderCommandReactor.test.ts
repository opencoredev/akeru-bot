import { BotId, DEFAULT_PROVIDER_INTERACTION_MODE, GroupId, ThreadId } from "@akeru/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  type ControllerEngineThread,
  resolveControllerBotId,
} from "./ProviderCommandReactor.ts";
import { createProviderCommandHarness } from "./test-support/ProviderCommandHarness.ts";

describe("ProviderCommandReactor", () => {
  const testScope = createProviderCommandHarness();
  afterEach(testScope.dispose);
  it("uses the responding group member before a direct thread bot", () => {
    expect(
      resolveControllerBotId({
        botId: BotId.make("bot-owner"),
        respondingBotId: BotId.make("bot-specialist"),
      }),
    ).toBe("bot-specialist");
    expect(resolveControllerBotId({ botId: BotId.make("bot-owner"), respondingBotId: null })).toBe(
      "bot-owner",
    );
  });

  it("accepts a thread shell without messages, activities, or checkpoints", () => {
    const shell: ControllerEngineThread = {
      id: ThreadId.make("thread-shell"),
      botId: BotId.make("bot-owner"),
      groupId: GroupId.make("group-1"),
      respondingBotId: BotId.make("bot-specialist"),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    };
    expect(resolveControllerBotId(shell)).toBe("bot-specialist");
    expect("messages" in shell).toBe(false);
    expect("activities" in shell).toBe(false);
    expect("checkpoints" in shell).toBe(false);
    expect("deletedAt" in shell).toBe(false);
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });
  });
});
