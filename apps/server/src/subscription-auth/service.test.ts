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
      health: "detected",
      healthTest: { status: "not-run" },
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
