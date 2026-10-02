import { describe, expect, it } from "vite-plus/test";
import { decodeServerSettings, decodeServerSettingsPatch } from "./settings.test-support.ts";

describe("ServerSettings bot sandbox and browser sharing", () => {
  it("defaults to separate and accepts shared as an opt-in", () => {
    expect(decodeServerSettings({}).botSandboxBrowserSharing).toBe("separate");
    expect(
      decodeServerSettingsPatch({ botSandboxBrowserSharing: "shared" }).botSandboxBrowserSharing,
    ).toBe("shared");
  });

  it("rejects unsupported sharing modes", () => {
    expect(() => decodeServerSettingsPatch({ botSandboxBrowserSharing: "per-thread" })).toThrow();
  });
});
