import {
  decodeServerSettings,
  encodeServerSettings,
  decodeImagePatch,
  fixture,
  seedApiKey,
  baseSettings,
  rows,
} from "./testUtils/imageService.ts";
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, type ImageGenerationSettings } from "@akeru/contracts";
import { makeTestSubscriptionAuthService } from "../subscription-auth/testUtils/subscriptionAuthService.ts";
import { imageProviderStatuses, normalizeImageGenerationPatch } from "./service.ts";

describe("image provider rows", () => {
  it("requires a ChatGPT account instead of an OpenAI API key", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "openai-codex");
    const service = await makeTestSubscriptionAuthService(authPath);

    const chatgpt = rows(service, { ...baseSettings, chatgptEnabled: true }).find(
      (row) => row.provider === "chatgpt",
    );

    expect(chatgpt?.connected).toBe(false);
    expect(chatgpt?.health).toBe("missing");
    expect(chatgpt?.repairAction).toBe("Connect ChatGPT subscription");
    expect(chatgpt?.healthTest).toEqual({ status: "not-run" });
  });
});

describe("imageGeneration settings patch normalization", () => {
  it("clears the default when the provider is disabled", () => {
    const current: ImageGenerationSettings = {
      chatgptEnabled: true,
      grokEnabled: false,
      defaultProvider: "chatgpt",
      fallbackOrder: ["chatgpt", "grok"],
    };

    const out = normalizeImageGenerationPatch(current, { chatgptEnabled: false });
    expect(out.defaultProvider).toBeNull();
  });

  it("drops disabled providers from a patched fallback order", () => {
    const current: ImageGenerationSettings = {
      chatgptEnabled: true,
      grokEnabled: true,
      defaultProvider: "grok",
      fallbackOrder: ["grok", "chatgpt"],
    };

    const out = normalizeImageGenerationPatch(current, {
      grokEnabled: false,
      fallbackOrder: ["grok", "chatgpt"],
    });

    expect(out.fallbackOrder).toEqual(["chatgpt"]);
    // The disabled default falls back to the first still-enabled provider.
    expect(out.defaultProvider).toBe("chatgpt");
  });

  it("normalizes to no default and an empty order when nothing stays enabled", () => {
    const current: ImageGenerationSettings = {
      chatgptEnabled: false,
      grokEnabled: true,
      defaultProvider: "grok",
      fallbackOrder: ["grok"],
    };

    // Disabling the only enabled provider leaves nothing selectable; the
    // merged settings are normalized to an empty order and a null default
    // rather than keeping a disabled provider in either slot.
    const out = normalizeImageGenerationPatch(current, { grokEnabled: false });
    expect(out.fallbackOrder).toEqual([]);
    expect(out.defaultProvider).toBeNull();
  });

  it("filters a supplied order that becomes empty after merging", () => {
    const current: ImageGenerationSettings = {
      chatgptEnabled: false,
      grokEnabled: true,
      defaultProvider: "grok",
      fallbackOrder: ["grok"],
    };

    const out = normalizeImageGenerationPatch(current, {
      grokEnabled: false,
      fallbackOrder: ["grok"],
    });

    expect(out.fallbackOrder).toEqual([]);
    expect(out.defaultProvider).toBeNull();
  });

  it("fills the default from the order when the previous default was cleared", () => {
    const current: ImageGenerationSettings = {
      chatgptEnabled: false,
      grokEnabled: false,
      defaultProvider: null,
      fallbackOrder: ["grok"],
    };

    const out = normalizeImageGenerationPatch(current, { grokEnabled: true });
    expect(out.defaultProvider).toBe("grok");
  });

  it("restores a selectable provider after all providers were disabled", () => {
    const current: ImageGenerationSettings = {
      chatgptEnabled: false,
      grokEnabled: false,
      defaultProvider: null,
      fallbackOrder: [],
    };

    const out = normalizeImageGenerationPatch(current, { grokEnabled: true });
    expect(out).toEqual({
      grokEnabled: true,
      defaultProvider: "grok",
      fallbackOrder: ["grok"],
    });
  });

  it("keeps a valid default and order untouched", () => {
    const current: ImageGenerationSettings = {
      chatgptEnabled: true,
      grokEnabled: true,
      defaultProvider: "grok",
      fallbackOrder: ["grok", "chatgpt"],
    };

    const out = normalizeImageGenerationPatch(current, { defaultProvider: "chatgpt" });
    expect(out.defaultProvider).toBe("chatgpt");
    expect(out.fallbackOrder).toBeUndefined();
  });
});

describe("imageGeneration settings schema", () => {
  it("decodes a settings file written before the imageGeneration field existed", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.imageGeneration).toEqual(DEFAULT_SERVER_SETTINGS.imageGeneration);
    expect(decoded.imageGeneration.fallbackOrder).toEqual(["chatgpt", "grok"]);
  });

  it("round-trips an enabled config through the settings schema", () => {
    const encoded = encodeServerSettings({
      ...DEFAULT_SERVER_SETTINGS,
      imageGeneration: {
        chatgptEnabled: true,
        grokEnabled: true,
        defaultProvider: "grok",
        fallbackOrder: ["grok", "chatgpt"],
      },
    });

    const decoded = decodeServerSettings(encoded);
    expect(decoded.imageGeneration.defaultProvider).toBe("grok");
    expect(decoded.imageGeneration.fallbackOrder).toEqual(["grok", "chatgpt"]);
  });

  it("rejects a fallback order with duplicate or unknown providers", () => {
    const decodePatch = decodeImagePatch;
    expect(decodePatch({ fallbackOrder: ["grok", "grok"] })._tag).toBe("Failure");
    expect(decodePatch({ fallbackOrder: ["chatgpt", "dall-e"] })._tag).toBe("Failure");
    expect(decodePatch({ fallbackOrder: [] })._tag).toBe("Failure");
    expect(decodePatch({ fallbackOrder: ["grok"] })._tag).toBe("Success");
  });
});

describe("image provider health test", () => {
  it("reports the last generation once an image is produced", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai");
    const service = await makeTestSubscriptionAuthService(authPath);
    service.recordImageGenerationSuccess("grok", "2026-09-25T10:00:00.000Z");
    const reloaded = await makeTestSubscriptionAuthService(authPath);

    const grok = imageProviderStatuses({
      settings: { ...baseSettings, grokEnabled: true },
      subscriptionStatuses: reloaded.statuses(),
      chatgptAccountConnected: reloaded.hasOpenAICodexAccount(),
      requestHealth: (provider) => reloaded.imageRequestHealth(provider),
      lastGenerationAt: (provider) => reloaded.imageLastGenerationAt(provider),
    }).find((row) => row.provider === "grok");

    expect(grok).toMatchObject({
      health: "healthy",
      lastGenerationAt: "2026-09-25T10:00:00.000Z",
      operations: ["generate", "edit"],
    });
  });
});
