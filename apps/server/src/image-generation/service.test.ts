// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ImageGenerationSettingsPatch,
  ServerSettings,
  type ImageGenerationSettings,
  type ImageProviderId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { SubscriptionAuthService } from "../subscription-auth/service.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeImagePatch = Schema.decodeUnknownExit(ImageGenerationSettingsPatch);
import {
  imageProviderStatuses,
  normalizeImageGenerationPatch,
  runImageProviderHealthTest,
} from "./service.ts";

function fixture() {
  const directory = NodePath.join(NodeOS.tmpdir(), `akeru-image-gen-${NodeCrypto.randomUUID()}`);
  NodeFS.mkdirSync(directory, { recursive: true });
  return { directory, authPath: NodePath.join(directory, "subscription-auth.json") };
}

function seedOAuth(authPath: string, provider: string) {
  const existing = NodeFS.existsSync(authPath)
    ? (JSON.parse(NodeFS.readFileSync(authPath, "utf-8")) as Record<string, unknown>)
    : {};
  existing[provider] = {
    type: "oauth",
    access: `${provider}-expired-access`,
    refresh: `${provider}-refresh`,
    expires: 0,
  };
  NodeFS.writeFileSync(authPath, JSON.stringify(existing));
}

function seedApiKey(authPath: string, provider: string, access = `${provider}-key`) {
  const existing = NodeFS.existsSync(authPath)
    ? (JSON.parse(NodeFS.readFileSync(authPath, "utf-8")) as Record<string, unknown>)
    : {};
  existing[provider] = { type: "api-key", access };
  NodeFS.writeFileSync(authPath, JSON.stringify(existing));
}

const baseSettings: ImageGenerationSettings = {
  chatgptEnabled: false,
  grokEnabled: false,
  defaultProvider: null,
  fallbackOrder: ["chatgpt", "grok"],
};

function rows(service: SubscriptionAuthService, settings: ImageGenerationSettings) {
  return imageProviderStatuses({
    settings,
    subscriptionStatuses: service.statuses(),
    requestHealth: (provider: ImageProviderId) => service.imageRequestHealth(provider),
  });
}

describe("image provider rows", () => {
  it("reports missing when no subscription is connected", () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);
    const chatgpt = rows(service, baseSettings).find((row) => row.provider === "chatgpt");
    expect(chatgpt).toMatchObject({
      connected: false,
      enabled: false,
      health: "missing",
      operations: ["generate"],
      repairAction: "Connect ChatGPT subscription",
    });
    expect(chatgpt?.lastGenerationAt).toBeUndefined();
    expect(chatgpt?.healthTest).toEqual({ status: "not-run" });
  });

  it("reports detected (not healthy) for a connected credential before any request", () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "openai-codex");
    const service = new SubscriptionAuthService(authPath);
    const chatgpt = rows(service, { ...baseSettings, chatgptEnabled: true }).find(
      (row) => row.provider === "chatgpt",
    );
    expect(chatgpt?.connected).toBe(true);
    expect(chatgpt?.health).toBe("detected");
    expect(chatgpt?.healthTest).toEqual({ status: "not-run" });
  });

  it("reports disabled for a connected-but-disabled provider", () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai");
    const service = new SubscriptionAuthService(authPath);
    const grok = rows(service, baseSettings).find((row) => row.provider === "grok");
    expect(grok).toMatchObject({ connected: true, enabled: false, health: "disabled" });
  });

  it("survives a service restart (health + failure persist in the health file)", () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai");
    const first = new SubscriptionAuthService(authPath);
    first.recordImageRequestSuccess("grok");
    first.recordImageRequestFailure("grok", "provider 500");
    const second = new SubscriptionAuthService(authPath);
    const grok = rows(second, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );
    expect(grok?.health).toBe("failed");
    expect(grok?.healthTest?.status).toBe("failed");
    expect(grok?.lastFailure?.message).toBe("provider 500");
    expect(grok?.repairAction).toBe("Run health test");
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

  it("drops a disabled provider from the persisted order even without an order patch", () => {
    const current: ImageGenerationSettings = {
      chatgptEnabled: true,
      grokEnabled: true,
      defaultProvider: "chatgpt",
      fallbackOrder: ["chatgpt", "grok"],
    };
    const out = normalizeImageGenerationPatch(current, { grokEnabled: false });
    expect(out.fallbackOrder).toEqual(["chatgpt"]);
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
  it("keeps generation unverified after an account probe succeeds", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai");
    const service = new SubscriptionAuthService(authPath);
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await runImageProviderHealthTest({ provider: "grok", subscriptionAuth: service, fetchFn });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.x.ai/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer xai-key" }),
      }),
    );
    const grok = rows(service, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );
    expect(grok?.health).toBe("detected");
    expect(grok?.healthTest?.status).toBe("passed");
  });

  it("probes a ChatGPT sign-in on the ChatGPT backend", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "chatgpt-access",
          refresh: "chatgpt-refresh",
          expires: Date.now() + 60_000,
          accountId: "acct-123",
        },
      }),
    );
    const service = new SubscriptionAuthService(authPath);
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await runImageProviderHealthTest({ provider: "chatgpt", subscriptionAuth: service, fetchFn });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer chatgpt-access",
          "ChatGPT-Account-ID": "acct-123",
        }),
      }),
    );
    expect(rows(service, { ...baseSettings, chatgptEnabled: true })[0]?.health).toBe("detected");
  });

  it("records a failure and never reports healthy on a rejected request", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "chatgpt-access",
          refresh: "chatgpt-refresh",
          expires: Date.now() + 60_000,
          accountId: "acct-123",
        },
      }),
    );
    const service = new SubscriptionAuthService(authPath);
    const fetchFn = vi.fn(async () => new Response("no", { status: 401 }));
    await runImageProviderHealthTest({ provider: "chatgpt", subscriptionAuth: service, fetchFn });
    const chatgpt = rows(service, { ...baseSettings, chatgptEnabled: true }).find(
      (row) => row.provider === "chatgpt",
    );
    expect(chatgpt?.health).toBe("failed-first-request");
    expect(chatgpt?.healthTest?.status).toBe("failed");
    expect(chatgpt?.lastFailure?.message).toContain("401");
  });

  it("records the real refresh failure (not 'not connected') when refresh rejects", async () => {
    const { authPath } = fixture();
    seedOAuth(authPath, "xai");
    const service = new SubscriptionAuthService(authPath);
    // Drive the real getAccessToken -> refreshCredential -> runRefresh path:
    // the provider's token endpoint rejects the refresh grant.
    const fetchFn = vi.fn(async (_input: unknown, _init?: unknown) =>
      Promise.resolve(new Response("invalid_grant", { status: 400 })),
    );
    vi.stubGlobal("fetch", fetchFn);
    try {
      await runImageProviderHealthTest({ provider: "grok", subscriptionAuth: service });
    } finally {
      vi.unstubAllGlobals();
    }
    // The refresh POST hit the real xAI token endpoint, not the models URL.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("x.ai");

    const reloaded = new SubscriptionAuthService(authPath);
    const grok = rows(reloaded, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );
    expect(grok?.connected).toBe(true);
    expect(grok?.health).toBe("failed-first-request");
    expect(grok?.healthTest?.status).toBe("failed");
    expect(grok?.lastFailure?.message).toContain("reconnected");
    expect(grok?.lastFailure?.message).not.toContain("No Grok subscription is connected");
  });

  it("records a durable revoked failure when the OAuth refresh rejects", async () => {
    const { authPath } = fixture();
    // Seed an expired OAuth credential whose refresh rejects: getAccessToken
    // throws inside the guarded path.
    seedOAuth(authPath, "xai");
    const service = new SubscriptionAuthService(authPath);
    const refresh = vi
      .spyOn(
        service as unknown as { refreshCredential: (p: string, c: unknown) => Promise<unknown> },
        "refreshCredential",
      )
      .mockRejectedValue(new Error("invalid_grant: refresh token revoked"));
    await runImageProviderHealthTest({ provider: "grok", subscriptionAuth: service });
    refresh.mockRestore();

    const grok = rows(service, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );
    expect(grok?.health).toBe("failed-first-request");
    expect(grok?.healthTest?.status).toBe("failed");
    expect(grok?.lastFailure?.message).toContain("revoked");

    // The failure is durable: a fresh service instance reads the same health.
    const reloaded = new SubscriptionAuthService(authPath);
    const reloadedRow = rows(reloaded, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );
    expect(reloadedRow?.health).toBe("failed-first-request");
  });

  it("redacts the access token when fetch throws an error containing it", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai", "super-secret-xai-token");
    const service = new SubscriptionAuthService(authPath);
    const fetchFn = vi.fn(async () => {
      throw new Error("connect failed for bearer super-secret-xai-token");
    });
    await runImageProviderHealthTest({ provider: "grok", subscriptionAuth: service, fetchFn });

    const reloaded = new SubscriptionAuthService(authPath);
    const grok = rows(reloaded, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );
    expect(grok?.health).toBe("failed-first-request");
    expect(grok?.lastFailure?.message).toContain("[redacted]");
    expect(grok?.lastFailure?.message).not.toContain("super-secret-xai-token");
    expect(NodeFS.readFileSync(`${authPath}.health`, "utf-8")).not.toContain(
      "super-secret-xai-token",
    );
  });

  it("records a failure without a connected credential", async () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);
    await runImageProviderHealthTest({ provider: "grok", subscriptionAuth: service });
    const grok = rows(service, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );
    expect(grok?.health).toBe("missing");
    expect(grok?.lastFailure?.message).toContain("subscription is connected");
  });
});
