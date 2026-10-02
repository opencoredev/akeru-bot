import {
  fixture,
  seedOAuth,
  seedChatGptSignIn,
  seedApiKey,
  baseSettings,
  rows,
} from "./testUtils/imageService.ts";
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { type ImageGenerationSettings } from "@akeru/contracts";
import { makeTestSubscriptionAuthService } from "../subscription-auth/testUtils/subscriptionAuthService.ts";
import { normalizeImageGenerationPatch, runImageProviderHealthTest } from "./service.ts";

describe("image provider rows", () => {
  it("reports missing when no subscription is connected", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    const chatgpt = rows(service, baseSettings).find((row) => row.provider === "chatgpt");
    expect(chatgpt).toMatchObject({
      connected: false,
      enabled: false,
      health: "missing",
      operations: ["generate", "edit"],
      repairAction: "Connect ChatGPT subscription",
    });
    expect(chatgpt?.lastGenerationAt).toBeUndefined();
    expect(chatgpt?.healthTest).toEqual({ status: "not-run" });
  });

  it("keeps an expired but refreshable OAuth credential connected", async () => {
    const { authPath } = fixture();
    seedOAuth(authPath, "openai-codex");
    const service = await makeTestSubscriptionAuthService(authPath);

    const chatgpt = rows(service, { ...baseSettings, chatgptEnabled: true }).find(
      (row) => row.provider === "chatgpt",
    );

    expect(chatgpt).toMatchObject({
      connected: true,
      health: "detected",
      healthTest: { status: "not-run" },
    });
    expect(chatgpt?.repairAction).toBeUndefined();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: "refreshed", refresh_token: "rotated", expires_in: 3600 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    try {
      expect(await service.getAccessToken("openai-codex")).toBe("refreshed");
      expect(rows(service, { ...baseSettings, chatgptEnabled: true })[0]?.health).toBe("detected");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers reconnect after an OAuth refresh grant is rejected", async () => {
    const { authPath } = fixture();
    seedOAuth(authPath, "openai-codex");
    const service = await makeTestSubscriptionAuthService(authPath);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    try {
      expect(await service.getAccessToken("openai-codex")).toBeUndefined();
      expect(rows(service, { ...baseSettings, chatgptEnabled: true })[0]).toMatchObject({
        health: "revoked",
        repairAction: "Reconnect ChatGPT subscription",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports disabled for a connected-but-disabled provider", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai");
    const service = await makeTestSubscriptionAuthService(authPath);
    const grok = rows(service, baseSettings).find((row) => row.provider === "grok");
    expect(grok).toMatchObject({ connected: true, enabled: false, health: "disabled" });
  });

  it("survives a service restart (health + failure persist in the health file)", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai");
    const first = await makeTestSubscriptionAuthService(authPath);
    first.recordImageRequestSuccess("grok");
    first.recordImageRequestFailure("grok", "provider 500");
    const second = await makeTestSubscriptionAuthService(authPath);

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
});

describe("image provider health test", () => {
  it("keeps image generation unverified after an account probe succeeds", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai");
    const service = await makeTestSubscriptionAuthService(authPath);
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

  it("records a failure and never reports healthy on a rejected request", async () => {
    const { authPath } = fixture();
    seedChatGptSignIn(authPath);
    const service = await makeTestSubscriptionAuthService(authPath);
    const fetchFn = vi.fn(async () => new Response("no", { status: 401 }));
    await runImageProviderHealthTest({ provider: "chatgpt", subscriptionAuth: service, fetchFn });

    const chatgpt = rows(service, { ...baseSettings, chatgptEnabled: true }).find(
      (row) => row.provider === "chatgpt",
    );

    expect(chatgpt?.health).toBe("revoked");
    expect(chatgpt?.healthTest?.status).toBe("failed");
    expect(chatgpt?.lastFailure?.message).toContain("401");
  });

  it("probes ChatGPT through the ChatGPT sign-in, not the OpenAI API", async () => {
    const { authPath } = fixture();
    seedChatGptSignIn(authPath);
    const service = await makeTestSubscriptionAuthService(authPath);
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

    const chatgpt = rows(service, { ...baseSettings, chatgptEnabled: true }).find(
      (row) => row.provider === "chatgpt",
    );

    expect(chatgpt?.health).toBe("detected");
  });

  it("never probes ChatGPT with an OpenAI API key", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "openai-codex");
    const service = await makeTestSubscriptionAuthService(authPath);
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await runImageProviderHealthTest({ provider: "chatgpt", subscriptionAuth: service, fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();

    const chatgpt = rows(service, { ...baseSettings, chatgptEnabled: true }).find(
      (row) => row.provider === "chatgpt",
    );

    expect(chatgpt?.health).toBe("missing");
    expect(chatgpt?.healthTest?.status).toBe("failed");
    expect(chatgpt?.lastFailure?.message).toContain("API key is not used");
  });

  it("keeps image request health separate from an account probe failure", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai");
    const service = await makeTestSubscriptionAuthService(authPath);
    await runImageProviderHealthTest({
      provider: "grok",
      subscriptionAuth: service,
      fetchFn: async () => new Response("unavailable", { status: 503 }),
    });

    const grok = rows(service, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );

    expect(grok?.health).toBe("detected");
    expect(grok?.healthTest?.status).toBe("failed");
    expect(grok?.lastFailure?.message).toContain("503");
  });

  it("shows the latest successful account probe after a failed probe", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai");
    const service = await makeTestSubscriptionAuthService(authPath);
    await runImageProviderHealthTest({
      provider: "grok",
      subscriptionAuth: service,
      fetchFn: async () => new Response("unavailable", { status: 503 }),
    });
    await runImageProviderHealthTest({
      provider: "grok",
      subscriptionAuth: service,
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    const reloaded = await makeTestSubscriptionAuthService(authPath);

    const grok = rows(reloaded, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );

    expect(grok?.health).toBe("detected");
    expect(grok?.healthTest?.status).toBe("passed");
    expect(grok?.lastFailure).toBeUndefined();
  });

  it("does not let an older image request failure override a successful account probe", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai");
    const service = await makeTestSubscriptionAuthService(authPath);
    service.recordImageRequestFailure("grok", "image request failed", "2020-01-01T00:00:00.000Z");
    await runImageProviderHealthTest({
      provider: "grok",
      subscriptionAuth: service,
      fetchFn: async () => new Response("{}", { status: 200 }),
    });

    const grok = rows(service, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );

    expect(grok?.health).toBe("failed-first-request");
    expect(grok?.healthTest?.status).toBe("passed");
  });

  it("records the real refresh failure (not 'not connected') when refresh rejects", async () => {
    const { authPath } = fixture();
    seedOAuth(authPath, "xai");
    const service = await makeTestSubscriptionAuthService(authPath);

    // Drive the real getAccessToken -> refreshCredential -> runRefresh path:
    // the provider's token endpoint rejects the refresh grant.
    const fetchFn = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
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

    const reloaded = await makeTestSubscriptionAuthService(authPath);

    const grok = rows(reloaded, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );

    expect(grok?.connected).toBe(true);
    expect(grok?.health).toBe("revoked");
    expect(grok?.healthTest?.status).toBe("failed");
    expect(grok?.lastFailure?.message).toContain("reconnected");
    expect(grok?.lastFailure?.message).not.toContain("No Grok subscription is connected");
  });

  it("records a durable revoked failure when the OAuth refresh rejects", async () => {
    const { authPath } = fixture();
    // Seed an expired OAuth credential whose refresh rejects: getAccessToken
    // throws inside the guarded path.
    seedOAuth(authPath, "xai");
    const service = await makeTestSubscriptionAuthService(authPath);

    const refresh = vi
      .spyOn(service, "getAccessToken")
      .mockRejectedValue(new Error("invalid_grant: refresh token revoked"));

    await runImageProviderHealthTest({ provider: "grok", subscriptionAuth: service });
    refresh.mockRestore();

    const grok = rows(service, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );

    expect(grok?.health).toBe("revoked");
    expect(grok?.healthTest?.status).toBe("failed");
    expect(grok?.lastFailure?.message).toContain("revoked");

    // The failure is durable: a fresh service instance reads the same health.
    const reloaded = await makeTestSubscriptionAuthService(authPath);

    const reloadedRow = rows(reloaded, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );

    expect(reloadedRow?.health).toBe("revoked");
  });

  it("redacts the access token when fetch throws an error containing it", async () => {
    const { authPath } = fixture();
    seedApiKey(authPath, "xai", "super-secret-xai-token");
    const service = await makeTestSubscriptionAuthService(authPath);

    const fetchFn = vi.fn(async () => {
      throw new Error("connect failed for bearer super-secret-xai-token");
    });

    await runImageProviderHealthTest({ provider: "grok", subscriptionAuth: service, fetchFn });

    const reloaded = await makeTestSubscriptionAuthService(authPath);

    const grok = rows(reloaded, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );

    expect(grok?.health).toBe("detected");
    expect(grok?.lastFailure?.message).toContain("[redacted]");
    expect(grok?.lastFailure?.message).not.toContain("super-secret-xai-token");
    expect(NodeFS.readFileSync(`${authPath}.health`, "utf-8")).not.toContain(
      "super-secret-xai-token",
    );
  });

  it("records a failure without a connected credential", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    await runImageProviderHealthTest({ provider: "grok", subscriptionAuth: service });

    const grok = rows(service, { ...baseSettings, grokEnabled: true }).find(
      (row) => row.provider === "grok",
    );

    expect(grok?.health).toBe("missing");
    expect(grok?.lastFailure?.message).toContain("subscription is connected");
  });
});
