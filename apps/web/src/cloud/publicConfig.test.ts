import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveCloudPublicConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveCloudPublicConfig", () => {
  it("accepts only secure relay URLs", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(resolveCloudPublicConfig().relayUrl).toBe("https://relay.example.test");

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");
    expect(resolveCloudPublicConfig().relayUrl).toBeNull();
  });
});
