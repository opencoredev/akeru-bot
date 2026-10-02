import { describe, expect, it } from "vite-plus/test";

import {
  CUSTOM_API_KEY_ENV,
  CUSTOM_API_PRESETS,
  customApiKeyHint,
  customApiPresetForBaseUrl,
  OTHER_CUSTOM_API_PRESET,
  withCustomApiKey,
} from "./customApiPresets";

function preset(id: string) {
  const match = CUSTOM_API_PRESETS.find((entry) => entry.id === id);

  if (!match) throw new Error(`missing preset ${id}`);

  return match;
}

describe("customApiPresetForBaseUrl", () => {
  it("matches a preset despite case and a trailing slash", () => {
    expect(customApiPresetForBaseUrl("HTTPS://openrouter.ai/api/v1/").id).toBe("openrouter");
  });

  it("falls back to Other for an unknown or empty URL", () => {
    expect(customApiPresetForBaseUrl("https://llm.internal/v1")).toBe(OTHER_CUSTOM_API_PRESET);
    expect(customApiPresetForBaseUrl("  ")).toBe(OTHER_CUSTOM_API_PRESET);
  });
});

describe("customApiKeyHint", () => {
  it("points a hosted service at its key page", () => {
    expect(customApiKeyHint(preset("openrouter"))).toBe(
      "Required. Create one at openrouter.ai/settings/keys.",
    );
  });

  it("tells local servers that no key is needed", () => {
    expect(customApiKeyHint(preset("ollama"))).toBe("Not needed for this server. Leave it empty.");
  });
});

describe("withCustomApiKey", () => {
  const other = { name: "HTTP_PROXY", value: "http://proxy", sensitive: false };

  it("adds the key as a sensitive variable", () => {
    expect(withCustomApiKey([other], "  sk-test  ")).toEqual([
      other,
      { name: CUSTOM_API_KEY_ENV, value: "sk-test", sensitive: true },
    ]);
  });

  it("replaces a stored key instead of duplicating it", () => {
    const stored = withCustomApiKey([other], "sk-old");

    expect(withCustomApiKey(stored, "sk-new")).toEqual([
      other,
      { name: CUSTOM_API_KEY_ENV, value: "sk-new", sensitive: true },
    ]);
  });

  it("removes the key when the value is empty", () => {
    expect(withCustomApiKey(withCustomApiKey([other], "sk-old"), "")).toEqual([other]);
  });
});
