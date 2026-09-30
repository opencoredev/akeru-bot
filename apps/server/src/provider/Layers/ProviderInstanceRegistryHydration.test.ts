import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("provider instance hydration", () => {
  it("does not start the standard OpenCode CLI by default but keeps explicit old instances", () => {
    const defaults = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    expect(defaults[ProviderInstanceId.make("opencode")]).toBeUndefined();
    expect(defaults[ProviderInstanceId.make("opencodeGo")]?.driver).toBe("opencodeGo");

    const legacyId = ProviderInstanceId.make("opencode_existing");
    const explicit = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [legacyId]: { driver: ProviderDriverKind.make("opencode") },
      },
    });
    expect(explicit[legacyId]?.driver).toBe("opencode");
  });
});
