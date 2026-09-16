import { describe, expect, it } from "vite-plus/test";

import { rebaseUneditedValue } from "./useBotProfileDraft";

describe("rebaseUneditedValue", () => {
  it("takes a newer snapshot value when the local field was untouched", () => {
    expect(rebaseUneditedValue("Research", "Research", "Planning")).toBe("Planning");
  });

  it("preserves a local edit when the snapshot changes", () => {
    expect(rebaseUneditedValue("My label", "Research", "Planning")).toBe("My label");
  });

  it("supports semantic equality for collection fields", () => {
    const current = ["calendar", "github"];
    const previous = ["github", "calendar"];
    const next = ["github"];
    const equal = (left: string[], right: string[]) =>
      [...left].sort().join() === [...right].sort().join();

    expect(rebaseUneditedValue(current, previous, next, equal)).toBe(next);
  });
});
