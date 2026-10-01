// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off

import { fixture } from "./testUtils/subscriptionAuthStorage.ts";
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId } from "@akeru/contracts";
import {
  makeTestSubscriptionAuthService,
  runWithNodeServices,
} from "./testUtils/subscriptionAuthService.ts";

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
    const service = await makeTestSubscriptionAuthService(authPath);
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
    const service = await makeTestSubscriptionAuthService(authPath);
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
    const service = await makeTestSubscriptionAuthService(authPath);
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
    const service = await makeTestSubscriptionAuthService(authPath);
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
    const service = await makeTestSubscriptionAuthService(authPath, { checkHealthOnConnect: true });
    const login = await service.startLogin("opencode-go");

    await expect(service.completeLogin(login.loginId, "go-key")).resolves.toEqual({
      status: "connected",
      health: "checking",
    });
    // Another service instance (another client connection) sees the in-flight check.
    const observer = await makeTestSubscriptionAuthService(authPath);
    expect(observer.statuses().find((s) => s.provider === "opencode-go")).toMatchObject({
      health: "detected",
      healthChecking: true,
    });

    release(new Response("{}", { status: 200 }));
    await service.awaitHealthCheck("opencode-go");

    expect(request).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/usage", expect.any(Object));
    await runWithNodeServices(observer.reload());
    const checked = observer.statuses().find((s) => s.provider === "opencode-go");
    expect(checked).toMatchObject({ health: "healthy", healthTest: { status: "passed" } });
    expect(checked?.healthChecking).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("records a failed post-login check without leaving the checking state", async () => {
    const { authPath } = fixture();
    recordRequests(403);
    const service = await makeTestSubscriptionAuthService(authPath, { checkHealthOnConnect: true });
    const login = await service.startLogin("anthropic", { authMode: "api-key" });
    await service.completeLogin(login.loginId, "bad-key");
    await service.awaitHealthCheck("anthropic");

    const status = service.statuses().find((s) => s.provider === "anthropic");
    expect(status?.health).toBe("revoked");
    expect(status?.healthChecking).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("clears checking state for a custom provider instance", async () => {
    const { authPath } = fixture();
    recordRequests();
    const service = await makeTestSubscriptionAuthService(authPath, { checkHealthOnConnect: true });
    const instanceId = ProviderInstanceId.make("grok_work");
    const login = await service.startLogin("xai", { instanceId, authMode: "api-key" });
    await service.completeLogin(login.loginId, "work-key");
    await service.awaitHealthCheck("xai", instanceId);

    const status = service.accountStatus("xai", instanceId);
    expect(status.health).toBe("healthy");
    expect(status.healthChecking).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("treats an abandoned post-login check as finished", async () => {
    const { authPath } = fixture();
    seedOAuth(authPath, "xai");
    NodeFS.writeFileSync(
      `${authPath}.health`,
      JSON.stringify({ xai: { healthCheckStartedAt: new Date(0).toISOString() } }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    const status = service.statuses().find((s) => s.provider === "xai");
    expect(status?.health).toBe("detected");
    expect(status?.healthChecking).toBeUndefined();
  });
});
