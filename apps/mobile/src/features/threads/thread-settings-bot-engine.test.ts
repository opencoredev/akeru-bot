import { EnvironmentId, ProviderInstanceId } from "@akeru/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeMobileBot } from "../../lib/mobile-fixtures.test-support";
import type { ModelOption } from "../../lib/modelOptions";
import type { ExistingThreadSettingsRouteSession } from "./thread-settings-session";
import { liveBotThreadSettings } from "./thread-settings-bot-engine";

const model: ModelOption = {
  key: "codex:new-model",
  label: "New model",
  subtitle: "Codex",
  providerKey: "codex",
  providerLabel: "Codex",
  providerDriver: "codex",
  isDefault: false,
  isLegacy: false,
  disabledReason: null,
  selection: { instanceId: ProviderInstanceId.make("codex"), model: "new-model" },
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "default",
        options: [
          { id: "default", label: "Provider default", isDefault: true },
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ],
  },
};

function settings(): ExistingThreadSettingsRouteSession {
  return {
    ownerId: "environment:chat",
    engineBotRef: { environmentId: EnvironmentId.make("environment"), botId: "bot-1" },
    providerGroups: [],
    selectedModel: { instanceId: ProviderInstanceId.make("codex"), model: "old-model" },
    onSelectModel: vi.fn(),
    optionDescriptors: [],
    onUpdateOptionSelections: vi.fn(),
    runtimeMode: "full-access",
    onUpdateRuntimeMode: vi.fn(),
  };
}

describe("live bot settings sheet", () => {
  it("shows a remote change and reset independently of the frozen composer snapshot", () => {
    const session = settings();

    const bot = makeMobileBot({
      engine: {
        provider: "codex",
        model: "new-model",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });

    const live = liveBotThreadSettings(session, bot, [model]);

    expect(live.selectedModel?.model).toBe("new-model");
    expect(live.optionDescriptors[0]?.currentValue).toBe("high");
    live.onUpdateOptionSelections([{ id: "reasoningEffort", value: "low" }]);
    expect(session.onSelectModel).toHaveBeenCalledWith({
      ...model,
      selection: { ...model.selection, options: [{ id: "reasoningEffort", value: "low" }] },
    });

    const reset = liveBotThreadSettings(
      session,
      { ...bot, engine: { provider: "codex", model: "new-model" } },
      [model],
    );

    expect(reset.optionDescriptors[0]?.currentValue).toBe("default");
  });

  it("leaves group and plain settings unchanged without a direct engine bot reference", () => {
    const { engineBotRef: _reference, ...session } = settings();
    const bot = makeMobileBot({ engine: { provider: "codex", model: "new-model" } });

    expect(liveBotThreadSettings(session, bot, [model])).toBe(session);
  });
});
