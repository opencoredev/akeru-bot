import { fixture } from "./testUtils/subscriptionAuthStorage.ts";
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeTestSubscriptionAuthService } from "./testUtils/subscriptionAuthService.ts";

import { accountScope, isAccountLimitMessage, limitRetryAt } from "./service.ts";

describe("linked subscription accounts", () => {
  it("uses linked accounts in priority order and skips one that hit a limit", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    const first = await service.startLogin("openai-codex", { authMode: "api-key" });
    expect(await service.completeLogin(first.loginId, "first-key")).toEqual({
      status: "connected",
    });

    const second = await service.startLogin("openai-codex", {
      authMode: "api-key",
      addAccount: true,
    });

    expect(await service.completeLogin(second.loginId, "second-key")).toEqual({
      status: "connected",
    });
    const [defaultId, addedId] = service.linkedAccountIds("openai-codex");
    expect(defaultId).toBe("default");
    expect(addedId).toMatch(/^acct-[a-z0-9]+$/);
    expect(await service.getAccessToken("openai-codex")).toBe("first-key");

    service.recordRequestFailure(
      "openai-codex",
      "You've hit your usage limit. Try again in 2 hours.",
      new Date().toISOString(),
    );
    expect(await service.getAccessToken("openai-codex")).toBe("second-key");
    expect(
      service
        .linkedAccountStatuses()
        .filter((status) => status.provider === "openai-codex")
        .map((status) => [status.accountId, status.active]),
    ).toEqual([
      ["default", false],
      [addedId, true],
    ]);
    // An ordinary failure does not bench the account.
    service.recordRequestFailure("openai-codex", "socket hang up", new Date().toISOString());
    expect(await service.getAccessToken("openai-codex")).toBe("second-key");

    await service.setAccountOrder("openai-codex", [addedId!, "default"]);
    const restarted = await makeTestSubscriptionAuthService(authPath);
    expect(restarted.linkedAccountIds("openai-codex")).toEqual([addedId, "default"]);
    await restarted.logout("openai-codex", accountScope(addedId!));
    expect(restarted.linkedAccountIds("openai-codex")).toEqual(["default"]);
    expect(NodeFS.readFileSync(authPath, "utf-8")).not.toContain("second-key");
  });

  it("records each turn's outcome on the account that turn used", async () => {
    const { authPath } = fixture();
    const service = await makeTestSubscriptionAuthService(authPath);
    const first = await service.startLogin("openai-codex", { authMode: "api-key" });
    await service.completeLogin(first.loginId, "first-key");

    const second = await service.startLogin("openai-codex", {
      authMode: "api-key",
      addAccount: true,
    });

    await service.completeLogin(second.loginId, "second-key");
    const [, addedId] = service.linkedAccountIds("openai-codex");

    expect(await service.getAccessToken("openai-codex", undefined, "thread-a")).toBe("first-key");
    service.recordRequestFailure(
      "openai-codex",
      "You've hit your usage limit. Try again in 2 hours.",
      new Date().toISOString(),
      "request",
      "thread-a",
    );
    // Thread B starts on the second account; a settings probe then reads the default scope.
    expect(await service.getAccessToken("openai-codex", undefined, "thread-b")).toBe("second-key");
    await service.getAccessToken("openai-codex");
    // A late limit from thread A must not bench the account thread B is using.
    service.recordRequestFailure(
      "openai-codex",
      "You've hit your usage limit. Try again in 2 hours.",
      new Date().toISOString(),
      "request",
      "thread-a",
    );
    service.recordRequestSuccess("openai-codex", new Date().toISOString(), "thread-b");
    expect(
      service
        .linkedAccountStatuses()
        .filter((status) => status.provider === "openai-codex")
        .map((status) => [status.accountId, status.active]),
    ).toEqual([
      ["default", false],
      [addedId, true],
    ]);
  });

  it("follows an account order saved by another service instance", async () => {
    const { authPath } = fixture();
    const controller = await makeTestSubscriptionAuthService(authPath);
    const first = await controller.startLogin("openai-codex", { authMode: "api-key" });
    await controller.completeLogin(first.loginId, "first-key");

    const second = await controller.startLogin("openai-codex", {
      authMode: "api-key",
      addAccount: true,
    });

    await controller.completeLogin(second.loginId, "second-key");
    const [, addedId] = controller.linkedAccountIds("openai-codex");
    expect(await controller.getAccessToken("openai-codex")).toBe("first-key");

    const settings = await makeTestSubscriptionAuthService(authPath);
    await settings.setAccountOrder("openai-codex", [addedId!, "default"]);
    expect(await controller.getAccessToken("openai-codex")).toBe("second-key");
  });

  it("reads a limit reset time from the provider message", () => {
    const at = "2026-10-01T00:00:00.000Z";
    expect(limitRetryAt("Rate limit reached. Try again in 1h 30m.", at)).toBe(
      "2026-10-01T01:30:00.000Z",
    );
    expect(limitRetryAt("Usage limit reached.", at)).toBe("2026-10-01T01:00:00.000Z");
    expect(isAccountLimitMessage("429 Too Many Requests")).toBe(true);
    expect(isAccountLimitMessage("socket hang up")).toBe(false);
  });

  it("reads the ChatGPT tier from a login saved before tiers were recorded", async () => {
    const { authPath } = fixture();
    const claims = { "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } };
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`,
          refresh: "refresh",
          expires: Date.now() + 60_000,
          accountId: "account-123",
        },
      }),
    );

    const status = (await makeTestSubscriptionAuthService(authPath))
      .statuses()
      .find((entry) => entry.provider === "openai-codex");

    expect(status?.plan).toBe("Plus");
  });
});

it("reads plan usage through the active account and picks up a shared limit", async () => {
  const { authPath } = fixture();
  const service = await makeTestSubscriptionAuthService(authPath);
  const first = await service.startLogin("opencode-go", { authMode: "api-key" });
  await service.completeLogin(first.loginId, "first-key");
  const second = await service.startLogin("opencode-go", { authMode: "api-key", addAccount: true });
  await service.completeLogin(second.loginId, "second-key");
  const firstAccess = await service.getPlanAccess("opencode-go");
  expect(firstAccess?.accessToken).toBe("first-key");
  const other = await makeTestSubscriptionAuthService(authPath);
  other.recordRequestFailure("opencode-go", "Rate limit reached. Try again in 2h.");
  const secondAccess = await service.getPlanAccess("opencode-go");
  expect(secondAccess?.accessToken).toBe("second-key");
  expect(secondAccess?.accountId).not.toBe(firstAccess?.accountId);
  expect(NodeFS.statSync(`${authPath}.accounts`).mode & 0o777).toBe(0o600);
});

it("keeps the provider available while another linked account can serve requests", async () => {
  const { authPath } = fixture();
  const service = await makeTestSubscriptionAuthService(authPath);
  const first = await service.startLogin("openai-codex", { authMode: "api-key" });
  await service.completeLogin(first.loginId, "first-key");

  const second = await service.startLogin("openai-codex", {
    authMode: "api-key",
    addAccount: true,
  });

  await service.completeLogin(second.loginId, "second-key");
  service.recordRequestFailure("openai-codex", "Rate limit reached.");
  service.recordProviderInstanceFailure("codex", "Rate limit reached.");
  expect(service.providerInstanceRequestHealth("codex")).toBeUndefined();
  expect(await service.getAccessToken("openai-codex")).toBe("second-key");
  service.recordRequestFailure("openai-codex", "Rate limit reached.");
  expect(service.providerInstanceRequestHealth("codex")?.health).toBe("failed-first-request");
  expect(await service.getAccessToken("openai-codex")).toBe("first-key");
});

it("disconnects the displayed active account after a reorder and then the remaining account", async () => {
  const { authPath } = fixture();
  const service = await makeTestSubscriptionAuthService(authPath);
  const first = await service.startLogin("openai-codex", { authMode: "api-key" });
  await service.completeLogin(first.loginId, "first-key");

  const second = await service.startLogin("openai-codex", {
    authMode: "api-key",
    addAccount: true,
  });

  await service.completeLogin(second.loginId, "second-key");
  const addedId = service.linkedAccountIds("openai-codex")[1]!;
  await service.setAccountOrder("openai-codex", [addedId, "default"]);
  expect(service.getApiKeyCredential("openai-codex")?.access).toBe("second-key");
  await service.logout("openai-codex");
  expect(service.linkedAccountIds("openai-codex")).toEqual(["default"]);
  expect(await service.getAccessToken("openai-codex")).toBe("first-key");
  await service.logout("openai-codex", "codex");
  expect(service.linkedAccountIds("openai-codex")).toEqual([]);
});

it("recovers from an account spending limit after its cooldown with the backup removed", async () => {
  const { authPath } = fixture();
  const service = await makeTestSubscriptionAuthService(authPath);
  const first = await service.startLogin("openai-codex", { authMode: "api-key" });
  await service.completeLogin(first.loginId, "first-key");

  const second = await service.startLogin("openai-codex", {
    authMode: "api-key",
    addAccount: true,
  });

  await service.completeLogin(second.loginId, "second-key");
  const addedId = service.linkedAccountIds("openai-codex")[1]!;
  const at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await service.getAccessToken("openai-codex");
  service.recordRequestFailure("openai-codex", "Spending limit reached. Try again in 1h.", at);
  service.recordProviderInstanceFailure("codex", "Spending limit reached.", at);
  await service.logout("openai-codex", accountScope(addedId));
  expect(service.linkedAccountIds("openai-codex")).toEqual(["default"]);
  expect(service.providerInstanceRequestHealth("codex")).toBeUndefined();
  expect(await service.getAccessToken("openai-codex")).toBe("first-key");
});

it("keeps a provider-only usage failure when no account limit was recorded", async () => {
  const { authPath } = fixture();
  const service = await makeTestSubscriptionAuthService(authPath);
  const first = await service.startLogin("openai-codex", { authMode: "api-key" });
  await service.completeLogin(first.loginId, "first-key");
  service.recordProviderInstanceFailure("codex", "Budget exceeded.");
  expect(service.providerInstanceRequestHealth("codex")?.health).toBe("failed-first-request");
});

it("keeps a limit cooldown when an older request reports success later", async () => {
  const { authPath } = fixture();
  const service = await makeTestSubscriptionAuthService(authPath);
  const first = await service.startLogin("openai-codex", { authMode: "api-key" });
  await service.completeLogin(first.loginId, "first-key");

  const second = await service.startLogin("openai-codex", {
    authMode: "api-key",
    addAccount: true,
  });

  await service.completeLogin(second.loginId, "second-key");
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  await service.getAccessToken("openai-codex", undefined, "thread-a");
  await service.getAccessToken("openai-codex", undefined, "thread-b");
  service.recordRequestFailure(
    "openai-codex",
    "Rate limit reached. Try again in 1h.",
    new Date().toISOString(),
    "request",
    "thread-b",
  );
  service.recordRequestSuccess("openai-codex", startedAt, "thread-a");
  expect(await service.getAccessToken("openai-codex")).toBe("second-key");
});

it("keeps a provider limit when backups exist but no account recorded the limit", async () => {
  const { authPath } = fixture();
  const service = await makeTestSubscriptionAuthService(authPath);
  const first = await service.startLogin("openai-codex", { authMode: "api-key" });
  await service.completeLogin(first.loginId, "first-key");

  const second = await service.startLogin("openai-codex", {
    authMode: "api-key",
    addAccount: true,
  });

  await service.completeLogin(second.loginId, "second-key");
  service.recordProviderInstanceFailure("codex", "Rate limit reached.");
  expect(service.providerInstanceRequestHealth("codex")?.health).toBe("failed-first-request");
});

it("keeps a rejected refresh revoked after the failed turn reports its outcome", async () => {
  const { authPath, directory } = fixture();
  NodeFS.writeFileSync(
    authPath,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "expired",
        refresh: "rejected",
        expires: 0,
        accountId: "main",
      },
      "account:openai-codex:backup": { type: "api-key", access: "backup-key" },
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
  );

  try {
    const service = await makeTestSubscriptionAuthService(authPath);
    expect(await service.getAccessToken("openai-codex", undefined, "failed-turn")).toBeUndefined();
    expect(await service.getAccessToken("openai-codex", undefined, "backup-turn")).toBe(
      "backup-key",
    );
    service.recordAccountRequestFailure(
      "openai-codex",
      "codex",
      "Token unavailable",
      new Date().toISOString(),
      "failed-turn",
    );
    expect(
      service
        .linkedAccountStatuses()
        .find((status) => status.provider === "openai-codex" && status.accountId === "default")
        ?.health,
    ).toBe("revoked");
    expect(await service.getAccessToken("openai-codex")).toBe("backup-key");
    service.recordRequestSuccess(
      "openai-codex",
      new Date(Date.now() + 1000).toISOString(),
      "failed-turn",
    );
    service.recordRequestFailure(
      "openai-codex",
      "socket hang up",
      new Date(Date.now() + 2000).toISOString(),
      "request",
      "failed-turn",
    );
    expect(service.getOAuthCredential("openai-codex")?.accountId).toBe("main");
  } finally {
    vi.unstubAllGlobals();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps a limit cooldown when the limited account reports a later success", async () => {
  const { authPath } = fixture();
  const service = await makeTestSubscriptionAuthService(authPath);
  const first = await service.startLogin("openai-codex", { authMode: "api-key" });
  await service.completeLogin(first.loginId, "first-key");

  const second = await service.startLogin("openai-codex", {
    authMode: "api-key",
    addAccount: true,
  });

  await service.completeLogin(second.loginId, "second-key");
  await service.getAccessToken("openai-codex", undefined, "thread-a");
  await service.getAccessToken("openai-codex", undefined, "thread-b");
  const failedAt = new Date(Date.now() - 60_000).toISOString();
  service.recordRequestFailure(
    "openai-codex",
    "Rate limit reached. Try again in 1h.",
    failedAt,
    "request",
    "thread-b",
  );
  service.recordRequestSuccess("openai-codex", new Date().toISOString(), "thread-a");
  expect(await service.getAccessToken("openai-codex")).toBe("second-key");
});

it("unblocks the provider when the limited account is removed or signs in again", async () => {
  const { authPath } = fixture();
  const service = await makeTestSubscriptionAuthService(authPath);
  const first = await service.startLogin("openai-codex", { authMode: "api-key" });
  await service.completeLogin(first.loginId, "first-key");

  const second = await service.startLogin("openai-codex", {
    authMode: "api-key",
    addAccount: true,
  });

  await service.completeLogin(second.loginId, "second-key");
  const addedId = service.linkedAccountIds("openai-codex")[1]!;
  await service.getAccessToken("openai-codex");
  service.recordRequestFailure("openai-codex", "Usage cap reached.");
  service.recordProviderInstanceFailure("codex", "Usage cap reached.");
  await service.logout("openai-codex", accountScope("default"));
  expect(service.linkedAccountIds("openai-codex")).toEqual([addedId]);
  expect(service.providerInstanceRequestHealth("codex")).toBeUndefined();

  service.recordRequestFailure("openai-codex", "Usage cap reached.");
  service.recordProviderInstanceFailure("codex", "Usage cap reached.");

  const again = await service.startLogin("openai-codex", {
    authMode: "api-key",
    accountId: addedId,
  });

  await service.completeLogin(again.loginId, "replacement-key");
  expect(service.providerInstanceRequestHealth("codex")).toBeUndefined();
  expect(await service.getAccessToken("openai-codex")).toBe("replacement-key");
});
