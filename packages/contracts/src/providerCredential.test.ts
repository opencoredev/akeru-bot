import { describe, expect, it } from "vite-plus/test";
import { instanceUsesSavedCredential } from "./providerCredential.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

describe("instanceUsesSavedCredential", () => {
  it("uses the saved OpenCode Go credential when unrelated config numbers overflow", () => {
    expect(
      instanceUsesSavedCredential("opencode-go", {
        driver: ProviderDriverKind.make("opencode"),
        environment: [
          { name: "OPENCODE_CONFIG_CONTENT", value: '{"unrelated":1e400}', sensitive: false },
        ],
      }),
    ).toBe(true);
  });
});
