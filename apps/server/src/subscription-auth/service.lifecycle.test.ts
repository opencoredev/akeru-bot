import { fixture, requestSignal } from "./testUtils/subscriptionAuthStorage.ts";
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { SubscriptionCredentialStore } from "./credentialStore.ts";
import {
  makeTestSubscriptionAuthService,
  runWithNodeServices,
} from "./testUtils/subscriptionAuthService.ts";

describe("subscription auth storage", () => {
  it("keeps a persisted plan account identity across OAuth refresh and service restarts", async () => {
    const { directory, authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        xai: {
          type: "oauth",
          access: "first-token",
          plan: "SuperGrok",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    const first = await service.getPlanAccess("xai");
    expect(first?.accountId).toBeTruthy();
    const data = JSON.parse(NodeFS.readFileSync(authPath, "utf8"));
    data.xai.expires = 0;
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
      expect(await service.getPlanAccess("xai")).toEqual({
        accessToken: "refreshed-token",
        accountId: first?.accountId,
      });
      expect(service.statuses().find((entry) => entry.provider === "xai")?.plan).toBe("SuperGrok");
      expect(await (await makeTestSubscriptionAuthService(authPath)).getPlanAccess("xai")).toEqual({
        accessToken: "refreshed-token",
        accountId: first?.accountId,
      });
      await service.logout("xai");
      expect(await service.getPlanAccess("xai")).toBeUndefined();
      NodeFS.writeFileSync(
        authPath,
        JSON.stringify({
          xai: {
            type: "oauth",
            access: "new-account-token",
            refresh: "new-refresh",
            expires: Date.now() + 60_000,
          },
        }),
      );
      expect((await service.getPlanAccess("xai"))?.accountId).not.toBe(first?.accountId);
    } finally {
      vi.unstubAllGlobals();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("clears only the matching image health when a credential changes", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
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

    await service.logout("openai-codex");
    expect(service.imageRequestHealth("chatgpt")).toBeUndefined();
  });

  it("reports a damaged credential file as a reconnect error until a login replaces it", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(authPath, "{not json");
    const service = await makeTestSubscriptionAuthService(authPath);

    for (const status of service.statuses()) {
      expect(status).toMatchObject({
        connected: false,
        health: "failed-first-request",
        lastFailedRequest: { message: expect.stringMatching(/damaged/) },
      });
    }

    expect(service.getApiKeyCredential("xai")).toBeUndefined();
    expect(service.isConnected("xai")).toBe(false);
    expect(await service.getAccessToken("xai")).toBeUndefined();

    // A later damaged version still has no good state behind it.
    NodeFS.writeFileSync(authPath, "{still not json");
    expect(service.statuses().every((status) => !status.connected)).toBe(true);
    expect(await service.getAccessToken("xai")).toBeUndefined();

    const login = await service.startLogin("xai", { authMode: "api-key" });
    await service.completeLogin(login.loginId, "xai-key");
    expect(NodeFS.readFileSync(`${authPath}.corrupt`, "utf8")).toBe("{still not json");
    expect(service.statuses().find((status) => status.provider === "xai")).toMatchObject({
      connected: true,
    });
    expect(service.statuses().find((status) => status.provider === "anthropic")?.health).not.toBe(
      "failed-first-request",
    );
  });

  it("sees a login completed by another service instance before admitting a turn", async () => {
    const { authPath } = fixture();
    const runtime = await makeTestSubscriptionAuthService(authPath);
    const loginService = await makeTestSubscriptionAuthService(authPath);
    expect(runtime.isConnected("openai-codex", "codex")).toBe(false);

    const login = await loginService.startLogin("openai-codex", { authMode: "api-key" });
    expect(await loginService.completeLogin(login.loginId, "test-key")).toEqual({
      status: "connected",
    });
    expect(runtime.isConnected("openai-codex", "codex")).toBe(true);

    await loginService.logout("openai-codex", "codex");
    expect(runtime.isConnected("openai-codex", "codex")).toBe(false);
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
      const service = await makeTestSubscriptionAuthService(authPath);
      let completeRequest!: (response: Response) => void;

      const response = new Promise<Response>((resolve) => {
        completeRequest = resolve;
      });

      const { requested, markRequested } = requestSignal();

      const request = vi.fn(() => {
        markRequested();

        return response;
      });

      vi.stubGlobal("fetch", request);

      try {
        const refreshing =
          operation === "refresh" ? service.getAccessToken("xai") : service.testHealth("xai");

        await requested;
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

  it("does not save a refreshed token after a concurrent logout reaches the store", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({ xai: { type: "oauth", access: "old", refresh: "old-refresh", expires: 0 } }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    const other = await makeTestSubscriptionAuthService(authPath);
    const store = service["store"];
    const originalUpdate = store.update;
    let releaseUpdate!: () => void;
    const held = new Promise<void>((resolve) => (releaseUpdate = resolve));
    let reachedUpdate!: () => void;
    const reached = new Promise<void>((resolve) => (reachedUpdate = resolve));

    const updateSpy = vi.spyOn(store, "update").mockImplementationOnce((f) => {
      reachedUpdate();

      return Effect.promise(() => held).pipe(Effect.andThen(originalUpdate(f)));
    });

    let completeRequest!: (response: Response) => void;
    const { requested, markRequested } = requestSignal();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        markRequested();

        return new Promise<Response>((resolve) => (completeRequest = resolve));
      }),
    );

    try {
      const refreshing = service.getAccessToken("xai");
      await requested;
      completeRequest(
        new Response(JSON.stringify({ access_token: "late-token", expires_in: 3600 }), {
          headers: { "content-type": "application/json" },
        }),
      );
      await reached;
      await other.logout("xai");
      releaseUpdate();
      expect(await refreshing).toBeUndefined();
      expect(service.isConnected("xai")).toBe(false);
      expect(JSON.parse(NodeFS.readFileSync(authPath, "utf-8"))).toEqual({});
    } finally {
      updateSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("does not save an API key when the login is cancelled while the store update waits", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    const login = await service.startLogin("xai", { authMode: "api-key" });
    const store = service["store"];
    const originalUpdate = store.update;
    let releaseUpdate!: () => void;
    const held = new Promise<void>((resolve) => (releaseUpdate = resolve));
    let reachedUpdate!: () => void;
    const reached = new Promise<void>((resolve) => (reachedUpdate = resolve));

    const updateSpy = vi.spyOn(store, "update").mockImplementationOnce((f) => {
      reachedUpdate();

      return Effect.promise(() => held).pipe(Effect.andThen(originalUpdate(f)));
    });

    try {
      const completing = service.completeLogin(login.loginId, "cancelled-key");
      await reached;
      service.cancelLogin(login.loginId);
      releaseUpdate();
      expect(await completing).toEqual({
        status: "failed",
        error: "Login cancelled. Start again.",
      });
      expect(service.isConnected("xai")).toBe(false);
      expect(
        NodeFS.existsSync(authPath) ? JSON.parse(NodeFS.readFileSync(authPath, "utf-8")) : {},
      ).toEqual({});
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("does not let an OAuth health check undo logout from another service", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        xai: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 },
      }),
    );
    const checking = await makeTestSubscriptionAuthService(authPath);
    const other = await makeTestSubscriptionAuthService(authPath);
    let completeRequest!: (response: Response) => void;
    const { requested, markRequested } = requestSignal();

    const request = vi.fn(() => {
      markRequested();

      return new Promise<Response>((resolve) => {
        completeRequest = resolve;
      });
    });

    vi.stubGlobal("fetch", request);

    try {
      const pending = checking.testHealth("xai");
      await requested;
      expect(request).toHaveBeenCalledOnce();
      await other.logout("xai");
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

  it("does not restore an OAuth login removed while a health check saves its refresh", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({ xai: { type: "oauth", access: "a", refresh: "r", expires: 0 } }),
    );
    const checking = await makeTestSubscriptionAuthService(authPath);
    const other = await makeTestSubscriptionAuthService(authPath);
    const store: SubscriptionCredentialStore = checking["store"];
    const write = store.update;
    let calls = 0;
    // Another client logs out after the ownership check passes, before the write lands.
    vi.spyOn(store, "update").mockImplementation((update) =>
      Effect.promise(async () => {
        if (++calls === 1) await other.logout("xai");
      }).pipe(Effect.andThen(write(update))),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "refreshed", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    try {
      await checking.testHealth("xai");
      expect(calls).toBeGreaterThan(0);
      expect(JSON.parse(NodeFS.readFileSync(authPath, "utf-8"))).toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not rewrite an unexpired OAuth credential during a health check", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        xai: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
      }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    const store: SubscriptionCredentialStore = service["store"];
    const update = vi.spyOn(store, "update");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );

    try {
      await service.testHealth("xai");
      expect(update).not.toHaveBeenCalled();
      expect(service.statuses().find((status) => status.provider === "xai")?.health).toBe(
        "healthy",
      );
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
      const oldRequest = requestSignal();
      const newRequest = requestSignal();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((resolve) => {
              const authorization = new Headers(init.headers).get("Authorization");

              if (authorization) {
                responses.set(authorization, resolve);

                if (authorization === "Bearer old-key") oldRequest.markRequested();

                if (authorization === "Bearer new-key") newRequest.markRequested();
              }
            }),
        ),
      );

      try {
        const oldService = await makeTestSubscriptionAuthService(authPath);
        const oldCheck = oldService.testHealth("xai");
        await oldRequest.requested;
        NodeFS.writeFileSync(authPath, JSON.stringify({ xai: credential("new-key") }));
        const newService = await makeTestSubscriptionAuthService(authPath);
        const newCheck = newService.testHealth("xai");
        await newRequest.requested;
        const respondNew = responses.get("Bearer new-key");
        const respondOld = responses.get("Bearer old-key");

        if (!respondNew || !respondOld) throw new TypeError("Expected both health requests.");
        respondNew(new Response("{}", { status: 200 }));
        await newCheck;
        respondOld(new Response("{}", { status: 401 }));
        await oldCheck;

        await runWithNodeServices(oldService.reload());
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
    const first = await makeTestSubscriptionAuthService(authPath);
    const login = await first.startLogin("anthropic", { authMode: "api-key" });
    const second = await makeTestSubscriptionAuthService(authPath);
    first.cancelLogin(login.loginId);
    expect(await second.completeLogin(login.loginId, "key")).toMatchObject({ status: "failed" });
    const pending = await first.startLogin("anthropic", { authMode: "api-key" });
    await second.logout("anthropic");
    expect(await first.completeLogin(pending.loginId, "key")).toMatchObject({ status: "failed" });
  });

  it("fails a Cursor login saved before Cursor was retired", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      `${authPath}.pending`,
      JSON.stringify([["login-cursor", { provider: "cursor", authMode: "api-key" }]]),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    expect(await service.pollLogin("login-cursor")).toMatchObject({ status: "failed" });
    expect(await service.completeLogin("login-cursor", "key")).toMatchObject({ status: "failed" });
    expect(service.getApiKeyCredential("cursor" as never)).toBeUndefined();
  });

  it("rejects invalid keys without replacing OAuth and clears old health on save", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        xai: {
          type: "oauth",
          access: "oauth",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    const status = () => service.statuses().find((entry) => entry.provider === "xai");
    service.recordRequestFailure("xai", "Old failure");
    const started = await service.startLogin("xai", { authMode: "api-key" });
    expect(await service.completeLogin(started.loginId, " \n ")).toMatchObject({
      status: "failed",
    });
    expect(await service.getAccessToken("xai")).toBe("oauth");
    expect(await service.completeLogin(started.loginId, "new-key")).toEqual({
      status: "connected",
    });
    expect(status()).toMatchObject({ health: "detected", healthTest: { status: "not-run" } });
    expect(status()?.lastFailedRequest).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://accounts.x.ai/device",
          verification_uri_complete: "https://accounts.x.ai/device?code=ABCD-EFGH",
          interval: 7,
          expires_in: 300,
        }),
      ),
    );

    try {
      const oauth = await service.startLogin("xai");
      expect(oauth.url).toContain("https://");
      service.cancelLogin(oauth.loginId);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(await service.getAccessToken("xai")).toBe("new-key");
    await service.logout("xai");
    expect(status()).toMatchObject({ connected: false });
    expect(status()?.authMode).toBeUndefined();
  });

  it("checks custom API endpoints without exposing network errors or using OAuth refresh", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);

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
        new URL("https://proxy.example/v1/models"),
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
    const service = await makeTestSubscriptionAuthService(authPath);

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

    const service = await makeTestSubscriptionAuthService(authPath);
    await service.testHealth("opencode-go");

    expect(request).toHaveBeenCalledWith(
      new URL("https://opencode.ai/zen/go/v1/usage"),
      expect.any(Object),
    );
    expect(service.statuses().find((status) => status.provider === "opencode-go")).toMatchObject({
      health: "healthy",
      healthTest: { status: "passed" },
    });
    vi.unstubAllGlobals();
  });

  it("persists pending logins across a server restart", async () => {
    const { authPath } = fixture();
    const first = await makeTestSubscriptionAuthService(authPath);
    const started = await first.startLogin("anthropic");

    const restarted = await makeTestSubscriptionAuthService(authPath);
    expect(await restarted.completeLogin(started.loginId, "restarted-key")).toEqual({
      status: "connected",
    });
    expect(restarted.getApiKeyCredential("anthropic")?.access).toBe("restarted-key");
    expect(NodeFS.statSync(`${authPath}.pending`).mode & 0o777).toBe(0o600);
  });

  it("reports expiry, failure, and recovery without calling detection healthy", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({ xai: { type: "oauth", access: "a", refresh: "r", expires: 100 } }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);

    expect(service.statuses([], 101).find((entry) => entry.provider === "xai")?.health).toBe(
      "expired",
    );
    service.recordRequestFailure("xai", "OAuth was revoked.", "2026-08-30T20:00:00.000Z");
    expect(service.statuses([], 50).find((entry) => entry.provider === "xai")?.health).toBe(
      "failed-first-request",
    );
    service.recordRequestSuccess("xai", "2026-08-30T20:01:00.000Z");
    expect(service.statuses([], 50).find((entry) => entry.provider === "xai")?.health).toBe(
      "recovered",
    );
    service.recordRequestFailure("xai", "OAuth was revoked.", "2026-08-30T20:02:00.000Z");
    expect(service.statuses([], 50).find((entry) => entry.provider === "xai")?.health).toBe(
      "failed",
    );
    service.recordRequestFailure(
      "xai",
      "OAuth was revoked.",
      "2026-08-30T20:03:00.000Z",
      "revoked",
    );
    expect(service.statuses([], 50).find((entry) => entry.provider === "xai")?.health).toBe(
      "revoked",
    );
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
    const service = await makeTestSubscriptionAuthService(authPath);
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
    const service = await makeTestSubscriptionAuthService(authPath);
    await service.testHealth("xai");

    expect(service.statuses().find((status) => status.provider === "xai")).toMatchObject({
      health: "healthy",
      healthTest: { status: "passed" },
      oauthCheck: { status: "passed" },
    });
    vi.unstubAllGlobals();
  });

  it("uses the last MCP health result when requests finish in the same millisecond", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    const at = "2026-08-31T20:00:00.000Z";

    service.recordMcpRequestFailure("builtin-github", "The request failed.", at);
    service.recordMcpRequestSuccess("builtin-github", at);
    expect(service.mcpRequestHealth("builtin-github")?.health).toBe("recovered");

    service.recordMcpRequestFailure("builtin-github", "The retry failed.", at);
    expect(service.mcpRequestHealth("builtin-github")?.health).toBe("failed");
  });

  it("preserves health updates written by another service instance", async () => {
    const { authPath } = fixture();
    const providerRuntime = await makeTestSubscriptionAuthService(authPath);
    const rpcRuntime = await makeTestSubscriptionAuthService(authPath);

    providerRuntime.recordProviderInstanceSuccess("grok", "2026-08-30T20:00:00.000Z");
    rpcRuntime.recordRequestFailure(
      "xai",
      "The OAuth grant was revoked.",
      "2026-08-30T20:01:00.000Z",
      "revoked",
    );

    const restarted = await makeTestSubscriptionAuthService(authPath);
    expect(restarted.providerInstanceHealth("grok")).toBe("healthy");
    expect(restarted.statuses().find((status) => status.provider === "xai")).toMatchObject({
      health: "missing",
      lastFailedRequest: { message: "The OAuth grant was revoked." },
    });
  });
});
