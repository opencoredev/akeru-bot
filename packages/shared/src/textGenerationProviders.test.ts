import { describe, expect, it } from "vite-plus/test";

import {
  NO_TEXT_GENERATION_DRIVER_KINDS,
  driverSupportsTextGeneration,
} from "./textGenerationProviders.ts";

describe("driverSupportsTextGeneration", () => {
  it("refuses drivers without text generation and allows the rest", () => {
    for (const driverKind of NO_TEXT_GENERATION_DRIVER_KINDS) {
      expect(driverSupportsTextGeneration(driverKind)).toBe(false);
    }

    expect(driverSupportsTextGeneration("codex")).toBe(true);
    expect(driverSupportsTextGeneration("claudeAgent")).toBe(true);
  });
});
