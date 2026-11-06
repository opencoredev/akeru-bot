import { fixture } from "./testUtils/subscriptionAuthStorage.ts";
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId } from "@akeru/contracts";
import { codexDeviceFetch } from "./testUtils/codexDeviceFetch.ts";
import { makeTestSubscriptionAuthService } from "./testUtils/subscriptionAuthService.ts";

describe("OAuth sign-in storage", () => {
  it("binds a completed OAuth sign-in to its selected instance", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "personal-access",
          refresh: "personal-refresh",
          expires: Date.now() + 60_000,
          accountId: "personal",
        },
      }),
    );
    vi.stubGlobal("fetch", codexDeviceFetch("work-access"));

    try {
      const service = await makeTestSubscriptionAuthService(authPath);

      const login = await service.startLogin("openai-codex", {
        instanceId: ProviderInstanceId.make("codex_work"),
      });

      expect(await service.pollLogin(login.loginId)).toEqual({ status: "connected" });
      const restarted = await makeTestSubscriptionAuthService(authPath);
      expect(await restarted.getAccessToken("openai-codex", "codex_work")).toBe("work-access");
      expect(await restarted.getAccessToken("openai-codex", "codex")).toBe("personal-access");
      await restarted.logout("openai-codex", "codex_work");
      expect(await restarted.getAccessToken("openai-codex", "codex")).toBe("personal-access");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("switches back to OAuth without retaining the API endpoint or key", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);

    const keyLogin = await service.startLogin("openai-codex", {
      authMode: "api-key",
      baseUrl: "https://proxy.example/v1",
    });

    await service.completeLogin(keyLogin.loginId, "old-api-key");
    service.recordRequestFailure("openai-codex", "Key rejected");
    vi.stubGlobal("fetch", codexDeviceFetch("oauth-access"));

    try {
      const oauth = await service.startLogin("openai-codex");
      expect(await service.pollLogin(oauth.loginId)).toEqual({ status: "connected" });
      const status = service.statuses().find((entry) => entry.provider === "openai-codex");
      expect(status).toMatchObject({ authMode: "oauth", health: "detected" });
      expect(status?.baseUrl).toBeUndefined();
      expect(service.getApiKeyCredential("openai-codex")).toBeUndefined();
      expect(NodeFS.readFileSync(authPath, "utf-8")).not.toContain("old-api-key");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
