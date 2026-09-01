import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import {
  resolveAgentAwarenessPlatformPresentation,
  resolveSettingsEnvironmentId,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("explains that agent awareness settings are unavailable on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: false,
      subtitle: "iOS only",
    });
  });

  it("leaves supported iOS settings unchanged", () => {
    expect(resolveAgentAwarenessPlatformPresentation("ios")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });
});

describe("resolveSettingsEnvironmentId", () => {
  const first = EnvironmentId.make("server-a");
  const second = EnvironmentId.make("server-b");

  it("uses the selected environment when several are saved", () => {
    expect(resolveSettingsEnvironmentId(second, [first, second])).toBe(second);
  });

  it("does not guess when several environments are saved", () => {
    expect(resolveSettingsEnvironmentId(null, [first, second])).toBeNull();
  });

  it("uses the only saved environment when no selection is available", () => {
    expect(resolveSettingsEnvironmentId(null, [first])).toBe(first);
  });
});
