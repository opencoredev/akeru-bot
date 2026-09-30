import { describe, expect, it } from "vite-plus/test";

import { botComposerState } from "./BotPromptComposer";

describe("bot composer state", () => {
  it("separates an empty composer from one holding a sendable draft", () => {
    expect(botComposerState({ disabled: false, busy: false, canSubmit: false })).toBe("empty");
    expect(botComposerState({ disabled: false, busy: false, canSubmit: true })).toBe("ready");
  });

  it("reports a running turn without taking the composer away", () => {
    expect(botComposerState({ disabled: false, busy: true, canSubmit: false })).toBe("sending");
    expect(botComposerState({ disabled: false, busy: true, canSubmit: true })).toBe("sending");
  });

  it("reports an unavailable composer ahead of every other state", () => {
    expect(botComposerState({ disabled: true, busy: true, canSubmit: true })).toBe("stopped");
    expect(botComposerState({ disabled: true, busy: false, canSubmit: false })).toBe("stopped");
  });
});
