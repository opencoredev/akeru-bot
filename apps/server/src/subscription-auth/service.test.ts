// @effect-diagnostics nodeBuiltinImport:off globalDate:off

import { fixture, requestSignal } from "./testUtils/subscriptionAuthStorage.ts";
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId } from "@akeru/contracts";
import { makeTestSubscriptionAuthService } from "./testUtils/subscriptionAuthService.ts";

describe("subscription auth storage", () => {
  it("uses the provider account ID and distinguishes a failed refresh from disconnect", async () => {
    const { directory, authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          accountId: "account-123",
        },
      }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    expect(await service.getPlanAccess("openai-codex")).toEqual({
      accessToken: "token",
      accountId: "account-123",
    });
    const data = JSON.parse(NodeFS.readFileSync(authPath, "utf8"));
    data["openai-codex"].expires = 0;
    NodeFS.writeFileSync(authPath, JSON.stringify(data));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    try {
      expect(await service.getPlanAccess("openai-codex")).toEqual({
        accessToken: null,
        accountId: "account-123",
      });
      expect(
        service.statuses().find((status) => status.provider === "openai-codex")?.connected,
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps using the last good credentials when the file is damaged after a good load", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    const login = await service.startLogin("xai", { authMode: "api-key" });
    await service.completeLogin(login.loginId, "xai-key");
    service.recordRequestSuccess("xai", "2026-09-25T00:00:00.000Z");

    NodeFS.writeFileSync(authPath, "{not json");
    const xai = service.statuses().find((status) => status.provider === "xai");
    expect(xai).toMatchObject({
      connected: true,
      authMode: "api-key",
      health: "healthy",
      lastSuccessfulRequestAt: "2026-09-25T00:00:00.000Z",
      healthTest: { status: "passed" },
      credentialWarning: { message: expect.stringMatching(/damaged/) },
    });
    expect(xai?.lastFailedRequest).toBeUndefined();
    expect(service.statuses().find((status) => status.provider === "anthropic")).toMatchObject({
      connected: false,
      health: "missing",
      credentialWarning: { message: expect.stringMatching(/damaged/) },
    });
    expect(service.isConnected("xai")).toBe(true);
    expect(service.getApiKeyCredential("xai")?.access).toBe("xai-key");
    expect(await service.getAccessToken("xai")).toBe("xai-key");

    // The next write rewrites the file from the last good state.
    const go = await service.startLogin("opencode-go");
    await service.completeLogin(go.loginId, "go-key");
    expect(NodeFS.readFileSync(`${authPath}.corrupt`, "utf8")).toBe("{not json");
    expect(await service.getAccessToken("xai")).toBe("xai-key");
    expect(service.statuses().every((status) => status.credentialWarning === undefined)).toBe(true);
  });

  it("sees credentials another writer saves without an explicit reload", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    expect(service.isConnected("xai")).toBe(false);

    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        xai: { type: "api-key", access: "external-key", baseUrl: "https://proxy.example/v1" },
        "apikey:openai": { type: "api_key", key: "mastra-key" },
      }),
    );
    expect(service.isConnected("xai")).toBe(true);
    expect(service.getApiKeyCredential("xai")).toEqual({
      type: "api-key",
      access: "external-key",
      baseUrl: "https://proxy.example/v1",
    });
    expect(service.statuses().find((status) => status.provider === "xai")).toMatchObject({
      connected: true,
      authMode: "api-key",
    });

    NodeFS.writeFileSync(authPath, JSON.stringify({}));
    expect(service.isConnected("xai")).toBe(false);
    expect(service.getApiKeyCredential("xai")).toBeUndefined();
  });

  it("keeps two instance accounts separate across restart and sign-out", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "legacy-access",
          refresh: "legacy-refresh",
          expires: Date.now() + 60_000,
          accountId: "personal",
        },
      }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    const runtime = await makeTestSubscriptionAuthService(authPath);

    const login = await service.startLogin("openai-codex", {
      instanceId: ProviderInstanceId.make("codex_work"),
      authMode: "api-key",
    });

    expect(await service.completeLogin(login.loginId, "work-key")).toEqual({ status: "connected" });
    expect(await runtime.getAccessToken("openai-codex", "codex_work")).toBe("work-key");

    const restarted = await makeTestSubscriptionAuthService(authPath);
    expect(await restarted.getOpenAICodexAccess("codex")).toEqual({
      accessToken: "legacy-access",
      accountId: "personal",
    });
    expect(restarted.getApiKeyCredential("openai-codex", "codex_work")?.access).toBe("work-key");
    expect(
      restarted.accountStatus("openai-codex", ProviderInstanceId.make("codex_work")),
    ).toMatchObject({ connected: true, authMode: "api-key" });
    expect(restarted.statuses().find((status) => status.provider === "openai-codex")).toMatchObject(
      { accountLabel: "personal", authMode: "oauth" },
    );

    restarted.recordAccountRequestSuccess("openai-codex", "codex_work", "2026-01-01T00:00:00.000Z");
    expect(
      restarted.accountStatus("openai-codex", ProviderInstanceId.make("codex_work")).health,
    ).toBe("healthy");
    expect(restarted.statuses().find((status) => status.provider === "openai-codex")?.health).toBe(
      "detected",
    );

    await restarted.logout("openai-codex", "codex_work");
    expect(restarted.isConnected("openai-codex", "codex_work")).toBe(false);
    expect(restarted.isConnected("openai-codex", "codex")).toBe(true);
    expect(NodeFS.readFileSync(authPath, "utf-8")).not.toContain("work-key");
  });

  it("removes credentials for deleted custom instances while preserving the default account", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);

    for (const instanceId of ["codex", "codex_work", "codex_other"]) {
      const login = await service.startLogin("openai-codex", {
        instanceId: ProviderInstanceId.make(instanceId),
        authMode: "api-key",
      });

      expect(await service.completeLogin(login.loginId, `${instanceId}-key`)).toEqual({
        status: "connected",
      });
    }

    await service.pruneDeletedInstanceCredentials(
      {
        codex: { driver: "codex" },
        codex_work: { driver: "codex" },
        codex_other: { driver: "codex" },
      },
      { codex_other: { driver: "codex" } },
    );

    const restarted = await makeTestSubscriptionAuthService(authPath);
    expect(restarted.isConnected("openai-codex", "codex")).toBe(true);
    expect(restarted.isConnected("openai-codex", "codex_work")).toBe(false);
    expect(restarted.isConnected("openai-codex", "codex_other")).toBe(true);
    expect(NodeFS.readFileSync(authPath, "utf-8")).not.toContain("codex_work-key");
  });

  it("reports a provider-supplied account identifier without returning credentials", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "private-access",
          refresh: "private-refresh",
          expires: Date.now() + 60_000,
          accountId: "account-123",
        },
      }),
    );

    const status = (await makeTestSubscriptionAuthService(authPath))
      .statuses()
      .find((entry) => entry.provider === "openai-codex");

    expect(status?.accountLabel).toBe("account-123");
    expect(JSON.stringify(status)).not.toContain("private-");
  });

  it("keeps API keys away from subscription plan endpoints except default OpenCode Go", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    const anthropic = await service.startLogin("anthropic", { authMode: "api-key" });
    await service.completeLogin(anthropic.loginId, "anthropic-key");
    expect(await service.getPlanAccessToken("anthropic")).toBeUndefined();
    const go = await service.startLogin("opencode-go");
    await service.completeLogin(go.loginId, "go-key");
    expect(await service.getPlanAccessToken("opencode-go")).toBe("go-key");

    const custom = await service.startLogin("opencode-go", {
      authMode: "api-key",
      baseUrl: "https://proxy.example/v1",
    });

    await service.completeLogin(custom.loginId, "custom-key");
    expect(await service.getPlanAccessToken("opencode-go")).toBeUndefined();
  });

  it("keeps the first of two concurrent refreshes when the refresh token does not rotate", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        xai: { type: "oauth", access: "old", refresh: "same-refresh", expires: 0 },
      }),
    );
    const first = await makeTestSubscriptionAuthService(authPath);
    const second = await makeTestSubscriptionAuthService(authPath);
    const responses: Array<(response: Response) => void> = [];
    const firstRequested = requestSignal();
    const secondRequested = requestSignal();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            responses.push(resolve);
            (responses.length === 1 ? firstRequested : secondRequested).markRequested();
          }),
      ),
    );

    const tokenResponse = (access: string) =>
      new Response(JSON.stringify({ access_token: access, expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
      });

    try {
      const firstRefresh = first.getAccessToken("xai");
      await firstRequested.requested;
      const secondRefresh = second.getAccessToken("xai");
      await secondRequested.requested;
      responses[0]!(tokenResponse("first-access"));
      expect(await firstRefresh).toBe("first-access");
      responses[1]!(tokenResponse("second-access"));
      // The slower refresh started from a credential that is no longer stored.
      expect(await secondRefresh).toBe("first-access");
      expect(JSON.parse(NodeFS.readFileSync(authPath, "utf-8")).xai.access).toBe("first-access");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("redacts saved API keys from provider failures recorded by an older runtime", async () => {
    const { authPath } = fixture();
    const runtime = await makeTestSubscriptionAuthService(authPath);
    const auth = await makeTestSubscriptionAuthService(authPath);
    const login = await auth.startLogin("xai", { authMode: "api-key" });
    await auth.completeLogin(login.loginId, "private-key");
    runtime.recordRequestFailure("xai", "Rejected private-key");
    expect(JSON.stringify(runtime.statuses())).not.toContain("private-key");
    expect(NodeFS.readFileSync(`${authPath}.health`, "utf-8")).not.toContain("private-key");
  });

  it.each(["anthropic", "openai-codex", "xai", "kimi-for-coding", "opencode-go"] as const)(
    "saves %s API keys through complete and never returns the key",
    async (provider) => {
      const { authPath } = fixture();
      const service = await makeTestSubscriptionAuthService(authPath);

      const options = {
        authMode: "api-key" as const,
        ...(provider === "xai" ? {} : { baseUrl: "https://proxy.example/v1/" }),
      };

      const started = await service.startLogin(provider, options);
      expect(started.completion).toBe("paste");
      expect(NodeFS.readFileSync(`${authPath}.pending`, "utf-8")).not.toContain("test-secret");
      const restarted = await makeTestSubscriptionAuthService(authPath);
      expect(await restarted.pollLogin(started.loginId)).toMatchObject({ status: "pending" });
      expect(await restarted.completeLogin(started.loginId, "  test-secret  ")).toEqual({
        status: "connected",
      });
      expect(await restarted.completeLogin(started.loginId, "replacement")).toMatchObject({
        status: "failed",
      });
      expect(restarted.getApiKeyCredential(provider)).toMatchObject({
        type: "api-key",
        access: "test-secret",
      });
      expect(restarted.statuses().find((status) => status.provider === provider)).toMatchObject({
        connected: true,
        authMode: "api-key",
      });
      expect(JSON.stringify(restarted.statuses())).not.toContain("test-secret");
      expect(NodeFS.statSync(authPath).mode & 0o777).toBe(0o600);
    },
  );

  it("rejects unsupported modes and base URLs before creating pending state", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    await expect(
      service.startLogin("xai", { authMode: "api-key", baseUrl: "https://example.com" }),
    ).rejects.toThrow("does not support");
    await expect(
      service.startLogin("anthropic", { baseUrl: "https://example.com" }),
    ).rejects.toThrow("require API-key");
    await expect(
      service.startLogin("anthropic", {
        authMode: "api-key",
        baseUrl: "https://user:secret@example.com",
      }),
    ).rejects.toThrow();
    expect(NodeFS.existsSync(`${authPath}.pending`)).toBe(false);
  });

  it("loads provider status without exposing tokens", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "secret-access",
          refresh: "secret-refresh",
          expires: 1_800_000_000_000,
        },
      }),
    );

    const service = await makeTestSubscriptionAuthService(authPath);
    const anthropic = service.statuses().find((status) => status.provider === "anthropic");
    expect(anthropic).toEqual({
      provider: "anthropic",
      connected: true,
      authMode: "oauth",
      expiresAt: 1_800_000_000_000,
      health: "detected",
      reconnectAction: "Reconnect account",
      healthTest: { status: "not-run" },
      dependentBots: [],
      dependentRoutines: [],
    });
    expect(JSON.stringify(service.statuses())).not.toContain("secret-access");
    expect(JSON.stringify(service.statuses())).not.toContain("secret-refresh");
  });

  it("returns a still-valid access token without rewriting storage", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        xai: {
          type: "oauth",
          access: "short-lived-access",
          refresh: "never-return-this",
          expires: Date.now() + 60_000,
        },
      }),
    );
    const before = NodeFS.readFileSync(authPath, "utf-8");
    const service = await makeTestSubscriptionAuthService(authPath);
    await expect(service.getAccessToken("xai")).resolves.toBe("short-lived-access");
    expect(NodeFS.readFileSync(authPath, "utf-8")).toBe(before);
  });

  it("stores an OpenCode Go API key without exposing it in status", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    const started = await service.startLogin("opencode-go");

    await expect(service.completeLogin(started.loginId, "  go-secret-key  ")).resolves.toEqual({
      status: "connected",
    });
    await expect(service.getAccessToken("opencode-go")).resolves.toBe("go-secret-key");
    expect(service.statuses().find((status) => status.provider === "opencode-go")).toMatchObject({
      connected: true,
      health: "detected",
      reconnectAction: "Replace API key",
    });
    expect(JSON.stringify(service.statuses())).not.toContain("go-secret-key");
    expect(NodeFS.statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it("returns Kimi access only with its persisted device identity", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-for-coding": {
          type: "oauth",
          access: "kimi-access",
          refresh: "kimi-refresh",
          expires: Date.now() + 60_000,
          deviceId: "0123456789abcdef0123456789abcdef",
        },
      }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    await expect(service.getKimiForCodingAccess()).resolves.toEqual({
      accessToken: "kimi-access",
      deviceId: "0123456789abcdef0123456789abcdef",
    });

    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        "kimi-for-coding": {
          type: "oauth",
          access: "old-access",
          refresh: "old-refresh",
          expires: Date.now() + 60_000,
        },
      }),
    );
    await expect(service.getKimiForCodingAccess()).resolves.toBeUndefined();
  });

  it("logs out atomically and secures the rewritten file", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        xai: { type: "oauth", access: "a", refresh: "r", expires: 1 },
      }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    await service.logout("xai");
    expect(JSON.parse(NodeFS.readFileSync(authPath, "utf-8"))).toEqual({});
    expect(NodeFS.statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it("tracks provider-instance failure and recovery from real requests", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);

    service.recordProviderInstanceFailure(
      "grok",
      "The first request failed.",
      "2026-08-30T20:00:00.000Z",
    );
    expect(service.providerInstanceHealth("grok")).toBe("failed-first-request");
    service.recordProviderInstanceSuccess("grok", "2026-08-30T20:01:00.000Z");
    expect(service.providerInstanceHealth("grok")).toBe("recovered");
    expect((await makeTestSubscriptionAuthService(authPath)).providerInstanceHealth("grok")).toBe(
      "recovered",
    );
  });

  it("persists MCP failure and recovery without storing tool output or tokens", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);

    service.recordMcpRequestFailure(
      "builtin-executor",
      "The MCP tool request failed.",
      "2026-08-31T19:00:00.000Z",
    );
    expect(service.mcpRequestHealth("builtin-executor")).toMatchObject({
      health: "failed-first-request",
      lastFailedRequest: { message: "The MCP tool request failed." },
    });
    service.recordMcpRequestSuccess("builtin-executor", "2026-08-31T20:00:00.000Z");
    const restarted = await makeTestSubscriptionAuthService(authPath);
    expect(restarted.mcpRequestHealth("builtin-executor")?.health).toBe("recovered");
    expect(JSON.stringify(restarted.mcpRequestHealth("builtin-executor"))).not.toContain("token");
  });
});
