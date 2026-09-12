import { describe, expect, it } from "vite-plus/test";

import { shouldBlurCommitOnKeyDown } from "./useCommitOnBlur";

function keyEvent(overrides: {
  key?: string;
  keyCode?: number;
  isComposing?: boolean;
}): Parameters<typeof shouldBlurCommitOnKeyDown>[0] {
  return {
    key: overrides.key ?? "Enter",
    keyCode: overrides.keyCode ?? 13,
    nativeEvent: { isComposing: overrides.isComposing ?? false },
  };
}

describe("shouldBlurCommitOnKeyDown", () => {
  it("commits on Enter after composition has finished", () => {
    expect(shouldBlurCommitOnKeyDown(keyEvent({ key: "Enter" }))).toBe(true);
  });

  it("keeps focus during IME composition", () => {
    expect(shouldBlurCommitOnKeyDown(keyEvent({ key: "Enter", isComposing: true }))).toBe(false);
    expect(shouldBlurCommitOnKeyDown(keyEvent({ key: "Enter", keyCode: 229 }))).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldBlurCommitOnKeyDown(keyEvent({ key: "Escape" }))).toBe(false);
  });
});
