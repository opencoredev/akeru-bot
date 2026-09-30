import type {
  ImageGenerationSettings,
  ImageProviderHealth,
  ImageProviderStatus,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botImageProviderOptionLabel,
  effectiveDefaultProvider,
  effectiveFallbackOrder,
  fallbackOrderError,
  globalDefaultOptionLabel,
  imageProviderAccessLabel,
  imageProviderGenerationLabel,
  imageProviderHealthDisplay,
  imageProviderHealthTestLabel,
  imageProviderOperationsLabel,
  imageProviderTogglePatch,
} from "./imageGeneration.js";

const BOTH: ImageGenerationSettings = {
  chatgptEnabled: true,
  grokEnabled: true,
  defaultProvider: "chatgpt",
  fallbackOrder: ["chatgpt", "grok"],
};
const NONE: ImageGenerationSettings = {
  chatgptEnabled: false,
  grokEnabled: false,
  defaultProvider: null,
  fallbackOrder: ["chatgpt", "grok"],
};

function status(
  health: ImageProviderHealth,
  overrides: Partial<ImageProviderStatus> = {},
): ImageProviderStatus {
  return {
    provider: "chatgpt",
    label: "ChatGPT",
    connected: true,
    enabled: true,
    health,
    operations: ["generate"],
    ...overrides,
  };
}

describe("imageProviderHealthDisplay", () => {
  it.each([
    ["detected", undefined, "Not tested", "warning"],
    ["healthy", undefined, "Not tested", "warning"],
    ["healthy", "passed", "Healthy", "success"],
    ["recovered", "passed", "Recovered", "success"],
    ["expired", undefined, "Expired", "error"],
    ["revoked", undefined, "Revoked", "error"],
    ["failed", "failed", "Failed", "error"],
    ["failed-first-request", "failed", "First request failed", "error"],
    ["unsupported", undefined, "Unsupported", "warning"],
  ] as const)("shows %s with test %s as %s", (health, test, label, variant) => {
    const row = status(health, test ? { healthTest: { status: test } } : {});
    expect(imageProviderHealthDisplay(row, true)).toEqual({ label, variant });
  });

  it("puts missing access and the local disabled flag before server health", () => {
    expect(imageProviderHealthDisplay(undefined, true).label).toBe("Checking");
    expect(imageProviderHealthDisplay(undefined, true, true)).toEqual({
      label: "Unavailable",
      variant: "error",
    });
    expect(imageProviderHealthDisplay(status("missing", { connected: false }), true).label).toBe(
      "Not connected",
    );
    expect(
      imageProviderHealthDisplay(status("healthy", { healthTest: { status: "passed" } }), false),
    ).toEqual({ label: "Disabled", variant: "secondary" });
  });

  it("names detected access", () => {
    expect(imageProviderAccessLabel(status("detected"))).toBe("ChatGPT subscription detected");
    expect(
      imageProviderAccessLabel(status("missing", { provider: "grok", connected: false })),
    ).toBe("No Grok subscription connected");
  });
});

describe("image provider detail labels", () => {
  const at = (iso: string) => `at ${iso}`;

  it("names supported operations", () => {
    expect(imageProviderOperationsLabel(status("healthy"))).toBe("Supports image generation");
    expect(
      imageProviderOperationsLabel(status("healthy", { operations: ["generate", "edit"] })),
    ).toBe("Supports image generation and editing");
    expect(imageProviderOperationsLabel(status("unsupported", { operations: [] }))).toBe(
      "No supported operations reported",
    );
  });

  it("shows the last generation time or an empty history", () => {
    expect(imageProviderGenerationLabel(status("healthy"), at)).toBe("No images generated yet");
    expect(imageProviderGenerationLabel(status("healthy", { lastGenerationAt: "T1" }), at)).toBe(
      "Last image at T1",
    );
  });

  it("shows the health test status and time", () => {
    expect(imageProviderHealthTestLabel(status("detected"), at)).toBe("Health test not run");
    expect(
      imageProviderHealthTestLabel(status("detected", { healthTest: { status: "not-run" } }), at),
    ).toBe("Health test not run");
    expect(
      imageProviderHealthTestLabel(
        status("healthy", { healthTest: { status: "passed", checkedAt: "T2" } }),
        at,
      ),
    ).toBe("Health test passed at T2");
    expect(
      imageProviderHealthTestLabel(status("failed", { healthTest: { status: "failed" } }), at),
    ).toBe("Health test failed");
  });

  it("annotates bot editor options that cannot create images", () => {
    expect(botImageProviderOptionLabel("chatgpt", BOTH, status("healthy"))).toBe("ChatGPT");
    expect(botImageProviderOptionLabel("chatgpt", NONE, status("healthy"))).toBe("ChatGPT (off)");
    expect(
      botImageProviderOptionLabel("chatgpt", BOTH, status("missing", { connected: false })),
    ).toBe("ChatGPT (not connected)");
    expect(botImageProviderOptionLabel("grok", BOTH, undefined)).toBe("Grok");
  });
});

describe("imageProviderTogglePatch", () => {
  it("enables a provider and makes it the default when it is the only one", () => {
    expect(imageProviderTogglePatch(NONE, "grok", true)).toEqual({
      grokEnabled: true,
      defaultProvider: "grok",
      fallbackOrder: ["grok"],
    });
  });

  it("disables the default provider and moves the default to the other one", () => {
    expect(imageProviderTogglePatch(BOTH, "chatgpt", false)).toEqual({
      chatgptEnabled: false,
      defaultProvider: "grok",
      fallbackOrder: ["grok"],
    });
  });

  it("disabling the last provider clears the default and keeps the saved order", () => {
    const onlyChatgpt = { ...NONE, chatgptEnabled: true, defaultProvider: "chatgpt" as const };
    expect(imageProviderTogglePatch(onlyChatgpt, "chatgpt", false)).toEqual({
      chatgptEnabled: false,
      defaultProvider: null,
    });
  });
});

describe("fallback order", () => {
  it("accepts a valid order", () => {
    expect(fallbackOrderError(["grok", "chatgpt"], BOTH)).toBeNull();
  });

  it("rejects empty, duplicate, oversized and disabled orders", () => {
    expect(fallbackOrderError([], BOTH)).toBe("Choose at least one provider.");
    expect(fallbackOrderError(["grok", "grok"], BOTH)).toBe("Each provider can appear only once.");
    expect(fallbackOrderError(["grok", "chatgpt", "grok"], BOTH)).toBe(
      "The order lists too many providers.",
    );
    expect(fallbackOrderError(["grok"], { ...BOTH, grokEnabled: false })).toBe(
      "Grok is turned off.",
    );
  });

  it("derives the effective order and default from enabled providers", () => {
    const grokFirst = { ...BOTH, fallbackOrder: ["grok"] as const, defaultProvider: null };
    expect(effectiveFallbackOrder(grokFirst)).toEqual(["grok", "chatgpt"]);
    expect(effectiveDefaultProvider(grokFirst)).toBe("grok");
    expect(effectiveDefaultProvider(NONE)).toBeNull();
  });

  it("labels the bot editor's global default option", () => {
    expect(globalDefaultOptionLabel(BOTH)).toBe("Use global default (ChatGPT)");
    expect(globalDefaultOptionLabel(NONE)).toBe("Use global default (none enabled)");
  });
});
