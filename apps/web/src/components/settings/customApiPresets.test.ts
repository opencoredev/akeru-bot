import { describe, expect, it } from "vite-plus/test";

import {
  CUSTOM_API_KEY_ENV,
  CUSTOM_API_PRESETS,
  customApiKeyHint,
  customApiKeyLeavesHost,
  customApiPresetForBaseUrl,
  OTHER_CUSTOM_API_PRESET,
  withCustomApiKey,
  withStoredCustomApiKey,
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

describe("withStoredCustomApiKey", () => {
  const other = { name: "HTTP_PROXY", value: "http://proxy", sensitive: false };
  const stored = { name: CUSTOM_API_KEY_ENV, value: "", sensitive: true, valueRedacted: true };

  it("keeps the stored key through ordinary environment edits", () => {
    expect(withStoredCustomApiKey([other], stored)).toEqual([other, stored]);
  });

  it("ignores a generic row that reuses the reserved name", () => {
    const collision = { name: CUSTOM_API_KEY_ENV, value: "", sensitive: true };

    expect(withStoredCustomApiKey([other, collision], stored)).toEqual([other, stored]);
    expect(withStoredCustomApiKey([other, collision], undefined)).toEqual([other]);
  });
});

describe("customApiKeyLeavesHost", () => {
  it("keeps the key when only the path or scheme changes", () => {
    expect(
      customApiKeyLeavesHost("https://openrouter.ai/api/v1", "https://openrouter.ai/api/v2"),
    ).toBe(false);
    expect(customApiKeyLeavesHost("http://localhost:1234/v1", "https://localhost:1234/v1")).toBe(
      false,
    );
  });

  it("drops the key when the base URL moves to another host", () => {
    expect(
      customApiKeyLeavesHost("https://openrouter.ai/api/v1", "https://api.groq.com/openai/v1"),
    ).toBe(true);
    expect(customApiKeyLeavesHost("http://localhost:1234/v1", "http://localhost:11434/v1")).toBe(
      true,
    );
    expect(customApiKeyLeavesHost("https://openrouter.ai/api/v1", "")).toBe(true);
  });

  it("keeps the key when the instance had no base URL yet", () => {
    expect(customApiKeyLeavesHost("", "https://openrouter.ai/api/v1")).toBe(false);
  });
});
