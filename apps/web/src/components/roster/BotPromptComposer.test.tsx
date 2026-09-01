import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { composerTestInstanceId, makeComposerTestProvider } from "../../test/chatComposerProps";
import {
  BotPromptComposer,
  canSubmitBotPrompt,
  findMentionedBotId,
  isBotPromptExpanded,
  shouldFocusBotPromptForKey,
} from "./BotPromptComposer";

describe("bot prompt composer", () => {
  it("does not submit while disabled", () => {
    expect(canSubmitBotPrompt(true, "Send this", 0)).toBe(false);
    expect(canSubmitBotPrompt(false, "Send this", 0)).toBe(true);
    expect(canSubmitBotPrompt(false, "", 1)).toBe(true);
  });

  it("expands for long or multiline prompts", () => {
    expect(isBotPromptExpanded("Short prompt")).toBe(false);
    expect(isBotPromptExpanded("Line one\nLine two")).toBe(true);
    expect(isBotPromptExpanded("x".repeat(81))).toBe(true);
  });

  it("routes the latest complete group mention to its bot", () => {
    expect(
      findMentionedBotId("Ask @Mori then @Path Finder ", [
        { id: "mori", name: "Mori" },
        { id: "pathfinder", name: "Path Finder" },
      ]),
    ).toBe("pathfinder");
    expect(findMentionedBotId("Email a@Mori.com", [{ id: "mori", name: "Mori" }])).toBeUndefined();
  });

  it("focuses the prompt for unmodified printable typing outside an editor", () => {
    const baseInput = {
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      editableTarget: false,
      isComposing: false,
      key: "a",
      metaKey: false,
    };

    expect(shouldFocusBotPromptForKey(baseInput)).toBe(true);
    expect(shouldFocusBotPromptForKey({ ...baseInput, key: "Enter" })).toBe(false);
    expect(shouldFocusBotPromptForKey({ ...baseInput, metaKey: true })).toBe(false);
    expect(shouldFocusBotPromptForKey({ ...baseInput, editableTarget: true })).toBe(false);
    expect(shouldFocusBotPromptForKey({ ...baseInput, isComposing: true })).toBe(false);
  });

  it("uses the available chat width", () => {
    const markup = renderToStaticMarkup(
      <BotPromptComposer
        botName="Akeru"
        disabled={false}
        modelPicker={null}
        onSubmit={vi.fn(async () => true)}
      />,
    );

    expect(markup).toContain('<form class="w-full ');
    expect(markup).not.toContain("max-w-4xl");
  });

  it("shows the active model and keeps it changeable", () => {
    const instanceEntries = deriveProviderInstanceEntries([makeComposerTestProvider()]);
    const markup = renderToStaticMarkup(
      <BotPromptComposer
        botName="Akeru"
        disabled={false}
        modelPicker={{
          activeInstanceId: composerTestInstanceId,
          model: "gpt-5-codex",
          instanceEntries,
          modelOptionsByInstance: new Map([
            [composerTestInstanceId, [{ slug: "gpt-5-codex", name: "Launchbar Model" }]],
          ]),
          onChange: vi.fn(),
        }}
        onSubmit={vi.fn(async () => true)}
      />,
    );

    expect(markup).toContain("Launchbar Model");
    expect(markup).toContain('aria-label="Change model"');
    expect(markup).toContain("data-chat-provider-model-picker");
  });
});
