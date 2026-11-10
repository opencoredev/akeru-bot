import { fixture } from "./testUtils/subscriptionAuthStorage.ts";
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@akeru/contracts";
import { CLAUDE_SUBSCRIPTION_RETIRED_MESSAGE, withoutRetiredLogins } from "./serviceTypes.ts";
import { makeTestSubscriptionAuthService } from "./testUtils/subscriptionAuthService.ts";

// Older versions saved Claude Pro or Max logins. Anthropic does not allow third-party
// apps to offer claude.ai sign-in, so the server ignores them and asks for an API key.
describe("retired Claude subscription logins", () => {
  it("removes every retired Claude login at startup and keeps the upgrade guidance", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "claude-access",
          refresh: "claude-refresh",
          expires: 1,
        },
        "instance:anthropic:claude_work": {
          type: "oauth",
          access: "work-access",
          refresh: "work-refresh",
          expires: Date.now() + 60_000,
        },
        "account:anthropic:backup-1": {
          type: "oauth",
          access: "backup-access",
          refresh: "backup-refresh",
          expires: 1,
        },
        xai: { type: "oauth", access: "xai-access", refresh: "xai-refresh", expires: 1 },
      }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);
    const saved = NodeFS.readFileSync(authPath, "utf-8");

    for (const token of ["claude-", "work-", "backup-"]) expect(saved).not.toContain(token);
    expect(saved).toContain("xai-access");

    // The guidance survives a restart: it lives in the health file, not the removed login.
    const restarted = await makeTestSubscriptionAuthService(authPath);
    const instanceId = ProviderInstanceId.make("claude_work");

    for (const status of [
      restarted.statuses().find((entry) => entry.provider === "anthropic"),
      restarted.accountStatus("anthropic", instanceId),
    ]) {
      expect(status).toMatchObject({
        connected: false,
        health: "missing",
        reconnectAction: "Connect API key",
        credentialWarning: { message: CLAUDE_SUBSCRIPTION_RETIRED_MESSAGE },
      });
    }

    expect(restarted.hasRetiredLogin("anthropic")).toBe(true);
    expect(restarted.hasRetiredLogin("anthropic", "claude_work")).toBe(true);
    expect(service.hasRetiredLogin("xai")).toBe(false);

    // An API key for one scope clears that scope's guidance only.
    const login = await restarted.startLogin("anthropic", { instanceId });
    await restarted.completeLogin(login.loginId, "sk-ant-work");
    expect(restarted.hasRetiredLogin("anthropic", "claude_work")).toBe(false);
    expect(restarted.accountStatus("anthropic", instanceId).credentialWarning).toBeUndefined();
    expect(restarted.hasRetiredLogin("anthropic")).toBe(true);
  });

  it("keeps an API-key backup account serving Claude after removing the logins", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        anthropic: { type: "oauth", access: "claude-access", refresh: "r", expires: 1 },
        "account:anthropic:backup-key": { type: "api-key", access: "sk-ant-backup" },
      }),
    );
    const service = await makeTestSubscriptionAuthService(authPath);

    expect(NodeFS.readFileSync(authPath, "utf-8")).not.toContain("claude-access");
    expect(service.getApiKeyCredential("anthropic")?.access).toBe("sk-ant-backup");
    expect(service.statuses().find((entry) => entry.provider === "anthropic")).toMatchObject({
      connected: true,
    });
  });

  it("treats a removed Claude login as not connected until an API key replaces it", async () => {
    const { authPath } = fixture();
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        anthropic: { type: "oauth", access: "claude-access", refresh: "r", expires: 1 },
        "instance:anthropic:claude_work": {
          type: "oauth",
          access: "work-access",
          refresh: "r",
          expires: Date.now() + 60_000,
        },
      }),
    );
    NodeFS.writeFileSync(
      `${authPath}.pending`,
      JSON.stringify([["old-claude-login", { provider: "anthropic", verifier: "v" }]]),
    );
    const service = await makeTestSubscriptionAuthService(authPath);

    expect(service.isConnected("anthropic")).toBe(false);
    expect(service.isConnected("anthropic", "claude_work")).toBe(false);
    expect(service.hasRetiredLogin("anthropic")).toBe(true);
    expect(service.hasRetiredLogin("anthropic", "claude_work")).toBe(true);
    expect(service.getOAuthCredential("anthropic")).toBeUndefined();
    expect(await service.getAccessToken("anthropic", "claude_work")).toBeUndefined();
    expect(await service.pollLogin("old-claude-login")).toMatchObject({ status: "failed" });
    expect(service.linkedAccountStatuses().some((s) => s.provider === "anthropic")).toBe(false);
    expect(
      service.accountStatus("anthropic", ProviderInstanceId.make("claude_work")),
    ).toMatchObject({
      connected: false,
      reconnectAction: "Connect API key",
      credentialWarning: { message: CLAUDE_SUBSCRIPTION_RETIRED_MESSAGE },
    });
    await expect(service.startLogin("anthropic", { authMode: "oauth" })).rejects.toThrow(
      CLAUDE_SUBSCRIPTION_RETIRED_MESSAGE,
    );

    const login = await service.startLogin("anthropic");
    expect(login).toMatchObject({ completion: "paste", url: "" });
    expect(await service.completeLogin(login.loginId, "sk-ant-key")).toEqual({
      status: "connected",
    });
    expect(service.getApiKeyCredential("anthropic")?.access).toBe("sk-ant-key");
    expect(service.hasRetiredLogin("anthropic")).toBe(false);
    const status = service.statuses().find((entry) => entry.provider === "anthropic");
    expect(status).toMatchObject({ connected: true, authMode: "api-key" });
    expect(status?.credentialWarning).toBeUndefined();
  });

  it("still ignores a Claude login another writer saves after startup", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "late-access",
          refresh: "r",
          expires: Date.now() + 60_000,
        },
      }),
    );

    expect(service.isConnected("anthropic")).toBe(false);
    expect(await service.getAccessToken("anthropic")).toBeUndefined();
    expect(service.hasRetiredLogin("anthropic")).toBe(true);
    expect(
      service.statuses().find((entry) => entry.provider === "anthropic")?.credentialWarning
        ?.message,
    ).toBe(CLAUDE_SUBSCRIPTION_RETIRED_MESSAGE);
  });

  it("deletes only the retired logins whose guidance marker was saved", () => {
    const oauth = { type: "oauth" as const, access: "a", refresh: "r", expires: 1 };

    const data = {
      anthropic: oauth,
      // Added by another process after the startup snapshot, so it has no marker yet.
      "instance:anthropic:work": oauth,
      "account:anthropic:key": { type: "api-key" as const, access: "sk-ant" },
    };

    expect(Object.keys(withoutRetiredLogins(data, new Set(["anthropic"])))).toEqual([
      "instance:anthropic:work",
      "account:anthropic:key",
    ]);
  });
});
