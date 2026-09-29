// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";

import { SubscriptionAuthService } from "./service.ts";

function fixture() {
  const directory = NodePath.join(
    NodeOS.tmpdir(),
    `akeru-subscription-auth-${NodeCrypto.randomUUID()}`,
  );
  NodeFS.mkdirSync(directory, { recursive: true });
  const authPath = NodePath.join(directory, "subscription-auth.json");
  return { directory, authPath };
}

describe("subscription auth storage", () => {
  it("keeps a persisted plan account identity across OAuth refresh and service restarts", async () => {
    const { directory, authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "first-token",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      }),
    );
    const service = new SubscriptionAuthService(authPath);
    const first = await service.getPlanAccess("anthropic");
    expect(first?.accountId).toBeTruthy();
    const data = JSON.parse(NodeFS.readFileSync(authPath, "utf8"));
    data.anthropic.expires = 0;
    NodeFS.writeFileSync(authPath, JSON.stringify(data));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "refreshed-token",
              refresh_token: "refreshed-refresh",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
      ),
    );
    try {
      expect(await service.getPlanAccess("anthropic")).toEqual({
        accessToken: "refreshed-token",
        accountId: first?.accountId,
      });
      expect(await new SubscriptionAuthService(authPath).getPlanAccess("anthropic")).toEqual({
        accessToken: "refreshed-token",
        accountId: first?.accountId,
      });
      service.logout("anthropic");
      expect(await service.getPlanAccess("anthropic")).toBeUndefined();
      NodeFS.writeFileSync(
        authPath,
        JSON.stringify({
          anthropic: {
            type: "oauth",
            access: "new-account-token",
            refresh: "new-refresh",
            expires: Date.now() + 60_000,
          },
        }),
      );
      expect((await service.getPlanAccess("anthropic"))?.accountId).not.toBe(first?.accountId);
    } finally {
      vi.unstubAllGlobals();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

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
    const service = new SubscriptionAuthService(authPath);
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
  it("clears only the matching image health when a credential changes", async () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);
    const chatgpt = await service.startLogin("openai-codex", { authMode: "api-key" });
    const grok = await service.startLogin("xai", { authMode: "api-key" });
    await service.completeLogin(chatgpt.loginId, "chatgpt-key");
    await service.completeLogin(grok.loginId, "grok-key");
    service.recordImageRequestFailure("chatgpt", "Old ChatGPT failure");
    service.recordImageRequestFailure("grok", "Old Grok failure");

    const replacement = await service.startLogin("xai", { authMode: "api-key" });
    await service.completeLogin(replacement.loginId, "new-grok-key");
    expect(service.imageRequestHealth("grok")).toBeUndefined();
    expect(service.imageRequestHealth("chatgpt")?.lastFailedRequest?.message).toBe(
      "Old ChatGPT failure",
    );

    service.logout("openai-codex");
    expect(service.imageRequestHealth("chatgpt")).toBeUndefined();
  });
  it("keeps API keys away from subscription plan endpoints except default OpenCode Go", async () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);
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
  it("switches back to OAuth without retaining the API endpoint or key", async () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);
    const keyLogin = await service.startLogin("anthropic", {
      authMode: "api-key",
      baseUrl: "https://proxy.example/v1",
    });
    await service.completeLogin(keyLogin.loginId, "old-api-key");
    service.recordRequestFailure("anthropic", "Key rejected");
    const oauth = await service.startLogin("anthropic");
    const state = new URL(oauth.url).searchParams.get("state");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "oauth-access",
            refresh_token: "oauth-refresh",
            expires_in: 3600,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    try {
      expect(await service.completeLogin(oauth.loginId, `code#${state}`)).toEqual({
        status: "connected",
      });
      expect(service.statuses()[0]).toMatchObject({ authMode: "oauth", health: "detected" });
      expect(service.statuses()[0]?.baseUrl).toBeUndefined();
      expect(service.getApiKeyCredential("anthropic")).toBeUndefined();
      expect(NodeFS.readFileSync(authPath, "utf-8")).not.toContain("old-api-key");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["refresh", "health"] as const)(
    "does not let an in-flight OAuth %s replace a saved API key",
    async (operation) => {
      const { authPath } = fixture();
      NodeFS.writeFileSync(
        authPath,
        JSON.stringify({
          xai: { type: "oauth", access: "old", refresh: "old-refresh", expires: 0 },
        }),
      );
      const service = new SubscriptionAuthService(authPath);
      let completeRequest!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => {
        completeRequest = resolve;
      });
      const request = vi.fn(() => response);
      vi.stubGlobal("fetch", request);
      try {
        const refreshing =
          operation === "refresh" ? service.getAccessToken("xai") : service.testHealth("xai");
        expect(request).toHaveBeenCalledOnce();
        const login = await service.startLogin("xai", { authMode: "api-key" });
        await service.completeLogin(login.loginId, "replacement-key");
        completeRequest(
          new Response(JSON.stringify({ access_token: "late-oauth-token", expires_in: 3600 }), {
            headers: { "content-type": "application/json" },
          }),
        );
        await refreshing;
        expect(service.getApiKeyCredential("xai")?.access).toBe("replacement-key");
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("does not let an OAuth health check undo logout from another service", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        xai: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 },
      }),
    );
    const checking = new SubscriptionAuthService(authPath);
    const other = new SubscriptionAuthService(authPath);
    let completeRequest!: (response: Response) => void;
    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          completeRequest = resolve;
        }),
    );
    vi.stubGlobal("fetch", request);
    try {
      const pending = checking.testHealth("xai");
      expect(request).toHaveBeenCalledOnce();
      other.logout("xai");
      completeRequest(
        new Response(JSON.stringify({ access_token: "late-access", expires_in: 3600 }), {
          headers: { "content-type": "application/json" },
        }),
      );
      await pending;
      const status = checking.statuses().find((entry) => entry.provider === "xai");
      expect(status?.connected).toBe(false);
      expect(status?.oauthCheck).toBeUndefined();
      expect(JSON.parse(NodeFS.readFileSync(authPath, "utf-8"))).toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["api-key", "oauth"] as const)(
    "ignores a rejected health check for replaced %s credentials",
    async (authMode) => {
      const { authPath } = fixture();
      const credential = (access: string) =>
        authMode === "api-key"
          ? { type: "api-key", access }
          : { type: "oauth", access, refresh: `${access}-refresh`, expires: Date.now() + 60_000 };
      NodeFS.writeFileSync(authPath, JSON.stringify({ xai: credential("old-key") }));
      const responses = new Map<string, (response: Response) => void>();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((resolve) => {
              const authorization = new Headers(init.headers).get("Authorization");
              if (authorization) responses.set(authorization, resolve);
            }),
        ),
      );
      try {
        const oldService = new SubscriptionAuthService(authPath);
        const oldCheck = oldService.testHealth("xai");
        NodeFS.writeFileSync(authPath, JSON.stringify({ xai: credential("new-key") }));
        const newService = new SubscriptionAuthService(authPath);
        const newCheck = newService.testHealth("xai");
        const respondNew = responses.get("Bearer new-key");
        const respondOld = responses.get("Bearer old-key");
        if (!respondNew || !respondOld) throw new TypeError("Expected both health requests.");
        respondNew(new Response("{}", { status: 200 }));
        await newCheck;
        respondOld(new Response("{}", { status: 401 }));
        await oldCheck;

        oldService.reload();
        expect(JSON.parse(NodeFS.readFileSync(authPath, "utf-8")).xai.access).toBe("new-key");
        expect(oldService.statuses().find((entry) => entry.provider === "xai")?.health).toBe(
          "healthy",
        );
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("removes pending API-key logins on logout and reads cancellations from disk", async () => {
    const { authPath } = fixture();
    const first = new SubscriptionAuthService(authPath);
    const login = await first.startLogin("anthropic", { authMode: "api-key" });
    const second = new SubscriptionAuthService(authPath);
    first.cancelLogin(login.loginId);
    expect(await second.completeLogin(login.loginId, "key")).toMatchObject({ status: "failed" });
    const pending = await first.startLogin("anthropic", { authMode: "api-key" });
    second.logout("anthropic");
    expect(await first.completeLogin(pending.loginId, "key")).toMatchObject({ status: "failed" });
  });

  it("redacts saved API keys from provider failures recorded by an older runtime", async () => {
    const { authPath } = fixture();
    const runtime = new SubscriptionAuthService(authPath);
    const auth = new SubscriptionAuthService(authPath);
    const login = await auth.startLogin("xai", { authMode: "api-key" });
    await auth.completeLogin(login.loginId, "private-key");
    runtime.recordRequestFailure("xai", "Rejected private-key");
    expect(JSON.stringify(runtime.statuses())).not.toContain("private-key");
    expect(NodeFS.readFileSync(`${authPath}.health`, "utf-8")).not.toContain("private-key");
  });
  it("fails a Cursor login saved before Cursor was retired", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      `${authPath}.pending`,
      JSON.stringify([["login-cursor", { provider: "cursor", authMode: "api-key" }]]),
    );
    const service = new SubscriptionAuthService(authPath);
    expect(await service.pollLogin("login-cursor")).toMatchObject({ status: "failed" });
    expect(await service.completeLogin("login-cursor", "key")).toMatchObject({ status: "failed" });
    expect(service.getApiKeyCredential("cursor")).toBeUndefined();
  });
  it.each(["anthropic", "openai-codex", "xai", "kimi-for-coding", "opencode-go"] as const)(
    "saves %s API keys through complete and never returns the key",
    async (provider) => {
      const { authPath } = fixture();
      const service = new SubscriptionAuthService(authPath);
      const options = {
        authMode: "api-key" as const,
        ...(provider === "xai" ? {} : { baseUrl: "https://proxy.example/v1/" }),
      };
      const started = await service.startLogin(provider, options);
      expect(started.completion).toBe("paste");
      expect(NodeFS.readFileSync(`${authPath}.pending`, "utf-8")).not.toContain("test-secret");
      const restarted = new SubscriptionAuthService(authPath);
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

  it("rejects invalid keys without replacing OAuth and clears old health on save", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "oauth",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      }),
    );
    const service = new SubscriptionAuthService(authPath);
    service.recordRequestFailure("anthropic", "Old failure");
    const started = await service.startLogin("anthropic", { authMode: "api-key" });
    expect(await service.completeLogin(started.loginId, " \n ")).toMatchObject({
      status: "failed",
    });
    expect(await service.getAccessToken("anthropic")).toBe("oauth");
    expect(await service.completeLogin(started.loginId, "new-key")).toEqual({
      status: "connected",
    });
    expect(service.statuses()[0]).toMatchObject({
      health: "detected",
      healthTest: { status: "not-run" },
    });
    expect(service.statuses()[0]?.lastFailedRequest).toBeUndefined();
    const oauth = await service.startLogin("anthropic");
    expect(oauth.url).toContain("https://");
    service.cancelLogin(oauth.loginId);
    expect(await service.getAccessToken("anthropic")).toBe("new-key");
    service.logout("anthropic");
    expect(service.statuses()[0]).toMatchObject({ connected: false });
    expect(service.statuses()[0]?.authMode).toBeUndefined();
  });

  it("rejects unsupported modes and base URLs before creating pending state", async () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);
    await expect(service.startLogin("cursor", { authMode: "api-key" })).rejects.toThrow(
      "not supported",
    );
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

  it("checks custom API endpoints without exposing network errors or using OAuth refresh", async () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);
    const started = await service.startLogin("anthropic", {
      authMode: "api-key",
      baseUrl: "https://proxy.example/v1",
    });
    await service.completeLogin(started.loginId, "private-key");
    const request = vi.fn().mockRejectedValue(new Error("private-key"));
    vi.stubGlobal("fetch", request);
    try {
      await service.testHealth("anthropic");
      expect(request).toHaveBeenCalledWith(
        "https://proxy.example/v1/models",
        expect.objectContaining({
          redirect: "error",
          headers: expect.objectContaining({ "x-api-key": "private-key" }),
        }),
      );
      expect(JSON.stringify(service.statuses())).not.toContain("private-key");
      expect(service.statuses()[0]?.oauthCheck).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns API-key Kimi access without an OAuth device identity", async () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);
    const started = await service.startLogin("kimi-for-coding", {
      authMode: "api-key",
      baseUrl: "http://localhost:8888/v1",
    });
    await service.completeLogin(started.loginId, "kimi-key");
    expect(await service.getKimiForCodingAccess()).toEqual({
      accessToken: "kimi-key",
      baseUrl: "http://localhost:8888/v1",
    });
  });
  it("loads provider status without exposing tokens", () => {
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

    const service = new SubscriptionAuthService(authPath);
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
    const service = new SubscriptionAuthService(authPath);
    await expect(service.getAccessToken("xai")).resolves.toBe("short-lived-access");
    expect(NodeFS.readFileSync(authPath, "utf-8")).toBe(before);
  });

  it("stores an OpenCode Go API key without exposing it in status", async () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);
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

  it("checks an OpenCode Go key against the entitlement endpoint", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({ "opencode-go": { type: "api-key", access: "go-secret-key" } }),
    );
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer go-secret-key");
      expect(headers.get("user-agent")).toBe("akeru-bot/0.0.37");
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", request);

    const service = new SubscriptionAuthService(authPath);
    await service.testHealth("opencode-go");

    expect(request).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/usage", expect.any(Object));
    expect(service.statuses().find((status) => status.provider === "opencode-go")).toMatchObject({
      health: "healthy",
      healthTest: { status: "passed" },
    });
    vi.unstubAllGlobals();
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
    const service = new SubscriptionAuthService(authPath);
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

  it("persists pending logins across a server restart", async () => {
    const { authPath } = fixture();
    const first = new SubscriptionAuthService(authPath);
    const started = await first.startLogin("anthropic");

    const restarted = new SubscriptionAuthService(authPath);
    const result = await restarted.completeLogin(started.loginId, "invalid-code");
    expect(result).toEqual({ status: "failed", error: "Invalid authorization state" });
    expect(NodeFS.statSync(`${authPath}.pending`).mode & 0o777).toBe(0o600);
  });

  it("logs out atomically and secures the rewritten file", () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        cursor: { type: "oauth", access: "a", refresh: "r", expires: 1 },
      }),
    );
    const service = new SubscriptionAuthService(authPath);
    service.logout("cursor");
    expect(JSON.parse(NodeFS.readFileSync(authPath, "utf-8"))).toEqual({});
    expect(NodeFS.statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it("reports expiry, failure, and recovery without calling detection healthy", () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 100 } }),
    );
    const service = new SubscriptionAuthService(authPath);

    expect(service.statuses([], 101)[0]?.health).toBe("expired");
    service.recordRequestFailure("anthropic", "OAuth was revoked.", "2026-08-30T20:00:00.000Z");
    expect(service.statuses([], 50)[0]?.health).toBe("failed-first-request");
    service.recordRequestSuccess("anthropic", "2026-08-30T20:01:00.000Z");
    expect(service.statuses([], 50)[0]?.health).toBe("recovered");
    service.recordRequestFailure("anthropic", "OAuth was revoked.", "2026-08-30T20:02:00.000Z");
    expect(service.statuses([], 50)[0]?.health).toBe("failed");
    service.recordRequestFailure(
      "anthropic",
      "OAuth was revoked.",
      "2026-08-30T20:03:00.000Z",
      "revoked",
    );
    expect(service.statuses([], 50)[0]?.health).toBe("revoked");
  });

  it("does not call an automatic OAuth refresh a successful provider request", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({ xai: { type: "oauth", access: "a", refresh: "r", expires: 0 } }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "refreshed", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const service = new SubscriptionAuthService(authPath);
    await service.getAccessToken("xai");

    expect(service.statuses().find((status) => status.provider === "xai")?.health).toBe("detected");
    vi.unstubAllGlobals();
  });

  it("keeps an OAuth check separate from a real provider health test", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({ xai: { type: "oauth", access: "a", refresh: "r", expires: 0 } }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "refreshed", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const service = new SubscriptionAuthService(authPath);
    await service.testHealth("xai");

    expect(service.statuses().find((status) => status.provider === "xai")).toMatchObject({
      health: "healthy",
      healthTest: { status: "passed" },
      oauthCheck: { status: "passed" },
    });
    vi.unstubAllGlobals();
  });

  it("tracks provider-instance failure and recovery from real requests", () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);

    service.recordProviderInstanceFailure(
      "grok",
      "The first request failed.",
      "2026-08-30T20:00:00.000Z",
    );
    expect(service.providerInstanceHealth("grok")).toBe("failed-first-request");
    service.recordProviderInstanceSuccess("grok", "2026-08-30T20:01:00.000Z");
    expect(service.providerInstanceHealth("grok")).toBe("recovered");
    expect(new SubscriptionAuthService(authPath).providerInstanceHealth("grok")).toBe("recovered");
  });

  it("persists MCP failure and recovery without storing tool output or tokens", () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);

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
    const restarted = new SubscriptionAuthService(authPath);
    expect(restarted.mcpRequestHealth("builtin-executor")?.health).toBe("recovered");
    expect(JSON.stringify(restarted.mcpRequestHealth("builtin-executor"))).not.toContain("token");
  });

  it("uses the last MCP health result when requests finish in the same millisecond", () => {
    const { authPath } = fixture();
    const service = new SubscriptionAuthService(authPath);
    const at = "2026-08-31T20:00:00.000Z";

    service.recordMcpRequestFailure("builtin-executor", "The request failed.", at);
    service.recordMcpRequestSuccess("builtin-executor", at);
    expect(service.mcpRequestHealth("builtin-executor")?.health).toBe("recovered");

    service.recordMcpRequestFailure("builtin-executor", "The retry failed.", at);
    expect(service.mcpRequestHealth("builtin-executor")?.health).toBe("failed");
  });

  it("preserves health updates written by another service instance", () => {
    const { authPath } = fixture();
    const providerRuntime = new SubscriptionAuthService(authPath);
    const rpcRuntime = new SubscriptionAuthService(authPath);

    providerRuntime.recordProviderInstanceSuccess("grok", "2026-08-30T20:00:00.000Z");
    rpcRuntime.recordRequestFailure(
      "xai",
      "The OAuth grant was revoked.",
      "2026-08-30T20:01:00.000Z",
      "revoked",
    );

    const restarted = new SubscriptionAuthService(authPath);
    expect(restarted.providerInstanceHealth("grok")).toBe("healthy");
    expect(restarted.statuses().find((status) => status.provider === "xai")).toMatchObject({
      health: "missing",
      lastFailedRequest: { message: "The OAuth grant was revoked." },
    });
  });
});

describe("provider health checks", () => {
  const kimiDeviceId = "0123456789abcdef0123456789abcdef";

  function seedOAuth(authPath: string, provider: string, extra: Record<string, unknown> = {}) {
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        [provider]: {
          type: "oauth",
          access: `${provider}-access`,
          refresh: `${provider}-refresh`,
          expires: Date.now() + 60 * 60_000,
          ...extra,
        },
      }),
    );
  }

  function recordRequests(status = 200) {
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response("{}", { status });
      }),
    );
    return calls;
  }

  it("checks Claude OAuth against the OAuth usage endpoint with a bearer token", async () => {
    const { authPath } = fixture();
    seedOAuth(authPath, "anthropic");
    const calls = recordRequests();
    const service = new SubscriptionAuthService(authPath);
    await service.testHealth("anthropic");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer anthropic-access");
    expect(calls[0]?.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(calls[0]?.headers.get("x-api-key")).toBeNull();
    expect(service.statuses().find((s) => s.provider === "anthropic")?.health).toBe("healthy");
    vi.unstubAllGlobals();
  });

  it("checks Codex OAuth against the ChatGPT usage endpoint", async () => {
    const { authPath } = fixture();
    seedOAuth(authPath, "openai-codex");
    const calls = recordRequests();
    const service = new SubscriptionAuthService(authPath);
    await service.testHealth("openai-codex");

    expect(calls.map((call) => call.url)).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer openai-codex-access");
    expect(service.statuses().find((s) => s.provider === "openai-codex")?.health).toBe("healthy");
    vi.unstubAllGlobals();
  });

  it("checks Grok OAuth against the xAI models endpoint and records rejection", async () => {
    const { authPath } = fixture();
    seedOAuth(authPath, "xai");
    const calls = recordRequests(401);
    const service = new SubscriptionAuthService(authPath);
    await service.testHealth("xai");

    expect(calls.map((call) => call.url)).toEqual(["https://api.x.ai/v1/models"]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer xai-access");
    expect(service.statuses().find((s) => s.provider === "xai")?.health).toBe("revoked");
    vi.unstubAllGlobals();
  });

  it("sends the Kimi device identity with the OAuth health request", async () => {
    const { authPath } = fixture();
    seedOAuth(authPath, "kimi-for-coding", { deviceId: kimiDeviceId });
    const calls = recordRequests();
    const service = new SubscriptionAuthService(authPath);
    await service.testHealth("kimi-for-coding");

    expect(calls.map((call) => call.url)).toEqual(["https://api.kimi.com/coding/v1/models"]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer kimi-for-coding-access");
    expect(calls[0]?.headers.get("x-msh-device-id")).toBe(kimiDeviceId);
    expect(calls[0]?.headers.get("x-msh-platform")).toBe("akeru");
    expect(service.statuses().find((s) => s.provider === "kimi-for-coding")?.health).toBe(
      "healthy",
    );
    vi.unstubAllGlobals();
  });

  it("checks OpenCode Go on the server right after the key is stored", async () => {
    const { authPath } = fixture();
    let release: (response: Response) => void = () => undefined;
    const request = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", request);
    const service = new SubscriptionAuthService(authPath, { checkHealthOnConnect: true });
    const login = await service.startLogin("opencode-go");

    await expect(service.completeLogin(login.loginId, "go-key")).resolves.toEqual({
      status: "connected",
      health: "checking",
    });
    // Another service instance (another client connection) sees the in-flight check.
    const observer = new SubscriptionAuthService(authPath);
    expect(observer.statuses().find((s) => s.provider === "opencode-go")).toMatchObject({
      health: "detected",
      healthChecking: true,
    });

    release(new Response("{}", { status: 200 }));
    await service.awaitHealthCheck("opencode-go");

    expect(request).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/usage", expect.any(Object));
    observer.reload();
    const checked = observer.statuses().find((s) => s.provider === "opencode-go");
    expect(checked).toMatchObject({ health: "healthy", healthTest: { status: "passed" } });
    expect(checked?.healthChecking).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("records a failed post-login check without leaving the checking state", async () => {
    const { authPath } = fixture();
    recordRequests(403);
    const service = new SubscriptionAuthService(authPath, { checkHealthOnConnect: true });
    const login = await service.startLogin("anthropic", { authMode: "api-key" });
    await service.completeLogin(login.loginId, "bad-key");
    await service.awaitHealthCheck("anthropic");

    const status = service.statuses().find((s) => s.provider === "anthropic");
    expect(status?.health).toBe("revoked");
    expect(status?.healthChecking).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("treats an abandoned post-login check as finished", () => {
    const { authPath } = fixture();
    seedOAuth(authPath, "xai");
    NodeFS.writeFileSync(
      `${authPath}.health`,
      JSON.stringify({ xai: { healthCheckStartedAt: new Date(0).toISOString() } }),
    );
    const service = new SubscriptionAuthService(authPath);
    const status = service.statuses().find((s) => s.provider === "xai");
    expect(status?.health).toBe("detected");
    expect(status?.healthChecking).toBeUndefined();
  });
});
