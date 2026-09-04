// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SubscriptionAuthService } from "./service.ts";
import {
  mergeSubscriptionInstanceEnvironment,
  subscriptionRequestUrl,
  subscriptionRuntimeEnvironment,
  withExplicitEnvironmentKeys,
} from "./runtime.ts";

const directories: string[] = [];
function fixture() {
  const secretsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-runtime-auth-"));
  directories.push(secretsDir);
  return { secretsDir, auth: SubscriptionAuthService.forSecretsDir(secretsDir) };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("subscription runtime credentials", () => {
  it.each([
    ["anthropic", "ANTHROPIC_API_KEY", "instance-key"],
    ["anthropic", "ANTHROPIC_API_KEY", ""],
    ["anthropic", "ANTHROPIC_AUTH_TOKEN", "instance-token"],
    ["anthropic", "CLAUDE_CODE_OAUTH_TOKEN", "instance-oauth"],
    ["anthropic", "ANTHROPIC_BASE_URL", "https://instance.example"],
    ["anthropic", "CLAUDE_CONFIG_DIR", "/instance/claude"],
    ["xai", "XAI_API_KEY", "instance-key"],
    ["opencode-go", "OPENCODE_API_KEY", "instance-key"],
  ] as const)(
    "preserves explicit %s %s settings even when equal to inherited values",
    async (provider, name, value) => {
      const { secretsDir, auth } = fixture();
      const login = await auth.startLogin(provider, { authMode: "api-key" });
      await auth.completeLogin(login.loginId, "provider-wide-key");
      const environment = {
        ...mergeSubscriptionInstanceEnvironment([{ name, value, sensitive: true }], {
          [name]: value,
          KEEP: "value",
        }),
      };
      expect(subscriptionRuntimeEnvironment(secretsDir, provider, environment)).toBe(environment);
      expect(environment[name]).toBe(value);
      expect(JSON.stringify(environment)).not.toContain("provider-wide-key");
    },
  );

  it("keeps a home-isolated Claude instance on its own account", async () => {
    const { secretsDir, auth } = fixture();
    const login = await auth.startLogin("anthropic", { authMode: "api-key" });
    await auth.completeLogin(login.loginId, "provider-wide-key");
    const merged = mergeSubscriptionInstanceEnvironment(undefined, {
      CLAUDE_CODE_OAUTH_TOKEN: "native-oauth",
    });
    const environment = withExplicitEnvironmentKeys(
      { ...merged, CLAUDE_CONFIG_DIR: "/instance/claude" },
      ["CLAUDE_CONFIG_DIR"],
    );
    expect(subscriptionRuntimeEnvironment(secretsDir, "anthropic", environment)).toBe(environment);
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBe("native-oauth");
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("replaces an inherited Grok key when only unrelated instance variables are explicit", async () => {
    const { secretsDir, auth } = fixture();
    const login = await auth.startLogin("xai", { authMode: "api-key" });
    await auth.completeLogin(login.loginId, "provider-wide-key");
    const environment = {
      ...mergeSubscriptionInstanceEnvironment(
        [{ name: "KEEP", value: "instance-value", sensitive: false }],
        { XAI_API_KEY: "inherited-key", KEEP: "inherited-value" },
      ),
    };
    expect(subscriptionRuntimeEnvironment(secretsDir, "xai", environment)).toEqual({
      XAI_API_KEY: "provider-wide-key",
      KEEP: "instance-value",
    });
  });

  it("does not override a directly supplied adapter environment", async () => {
    const { secretsDir, auth } = fixture();
    const login = await auth.startLogin("xai", { authMode: "api-key" });
    await auth.completeLogin(login.loginId, "provider-wide-key");
    const environment = { XAI_API_KEY: "adapter-key" };
    expect(subscriptionRuntimeEnvironment(secretsDir, "xai", environment)).toBe(environment);
  });

  it("distinguishes explicit OpenCode credentials from inherited OpenCode credentials", async () => {
    const { secretsDir, auth } = fixture();
    const login = await auth.startLogin("opencode-go", { authMode: "api-key" });
    await auth.completeLogin(login.loginId, "provider-wide-key");
    const content = JSON.stringify({
      provider: {
        "opencode-go": {
          options: { apiKey: "instance-key", baseURL: "https://instance.example/v1" },
        },
      },
    });
    const baseEnv = { OPENCODE_CONFIG_CONTENT: content };
    const explicit = {
      ...mergeSubscriptionInstanceEnvironment(
        [{ name: "OPENCODE_CONFIG_CONTENT", value: content, sensitive: true }],
        baseEnv,
      ),
    };
    expect(subscriptionRuntimeEnvironment(secretsDir, "opencode-go", explicit)).toBe(explicit);
    const inherited = { ...mergeSubscriptionInstanceEnvironment(undefined, baseEnv) };
    const result = subscriptionRuntimeEnvironment(secretsDir, "opencode-go", inherited);
    expect(JSON.parse(result.OPENCODE_CONFIG_CONTENT!).provider["opencode-go"].options).toEqual({
      apiKey: "provider-wide-key",
      baseURL: "https://opencode.ai/zen/go/v1",
    });
  });

  it.each([
    ["https://proxy.example", "https://proxy.example"],
    ["https://proxy.example/v1", "https://proxy.example"],
    ["https://proxy.example/v1/", "https://proxy.example"],
    ["https://proxy.example/gateway/v1/", "https://proxy.example/gateway"],
  ])("uses the same Claude root for health and SDK requests: %s", async (baseUrl, root) => {
    const { secretsDir, auth } = fixture();
    const login = await auth.startLogin("anthropic", { authMode: "api-key", baseUrl });
    await auth.completeLogin(login.loginId, "claude-key");
    const environment = subscriptionRuntimeEnvironment(
      secretsDir,
      "anthropic",
      mergeSubscriptionInstanceEnvironment(undefined, {}),
    );
    expect(environment.ANTHROPIC_BASE_URL).toBe(root);
    const request = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", request);
    try {
      await auth.testHealth("anthropic");
      expect(request).toHaveBeenCalledWith(
        `${environment.ANTHROPIC_BASE_URL}/v1/models`,
        expect.any(Object),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("reads Claude keys at process start and leaves the original environment unchanged", async () => {
    const { secretsDir, auth } = fixture();
    const environment = {
      ...mergeSubscriptionInstanceEnvironment(undefined, {
        CLAUDE_CODE_OAUTH_TOKEN: "native-oauth",
        ANTHROPIC_AUTH_TOKEN: "native-token",
        KEEP: "value",
      }),
    };
    expect(subscriptionRuntimeEnvironment(secretsDir, "anthropic", environment)).toBe(environment);
    const login = await auth.startLogin("anthropic", {
      authMode: "api-key",
      baseUrl: "https://proxy.example/v1",
    });
    await auth.completeLogin(login.loginId, "new-key");
    expect(subscriptionRuntimeEnvironment(secretsDir, "anthropic", environment)).toEqual({
      KEEP: "value",
      ANTHROPIC_API_KEY: "new-key",
      ANTHROPIC_BASE_URL: "https://proxy.example",
    });
    auth.logout("anthropic");
    expect(subscriptionRuntimeEnvironment(secretsDir, "anthropic", environment)).toBe(environment);
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBe("native-oauth");
  });

  it("passes saved Grok API keys to the ACP authentication environment", async () => {
    const { secretsDir, auth } = fixture();
    const login = await auth.startLogin("xai", { authMode: "api-key" });
    await auth.completeLogin(login.loginId, "grok-key");
    expect(subscriptionRuntimeEnvironment(secretsDir, "xai", { KEEP: "value" })).toEqual({
      KEEP: "value",
      XAI_API_KEY: "grok-key",
    });
  });

  it("merges OpenCode Go credentials without deleting other OpenCode providers or options", async () => {
    const { secretsDir, auth } = fixture();
    const login = await auth.startLogin("opencode-go", {
      authMode: "api-key",
      baseUrl: "https://proxy.example/v1",
    });
    await auth.completeLogin(login.loginId, "go-key");
    const result = subscriptionRuntimeEnvironment(secretsDir, "opencode-go", {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        theme: "dark",
        provider: { other: { name: "Other" }, "opencode-go": { options: { timeout: 1000 } } },
      }),
    });
    expect(JSON.parse(result.OPENCODE_CONFIG_CONTENT!)).toEqual({
      theme: "dark",
      provider: {
        other: { name: "Other" },
        "opencode-go": {
          options: { timeout: 1000, apiKey: "go-key", baseURL: "https://proxy.example/v1" },
        },
      },
    });
  });

  it("preserves Request bodies and URL suffixes when changing endpoints", async () => {
    const request = new Request("https://api.example/v1/messages?beta=true", {
      method: "POST",
      body: "request-body",
    });
    const rewritten = subscriptionRequestUrl(
      request,
      "https://api.example/v1",
      "http://localhost:8000/api",
    );
    expect(rewritten).toBeInstanceOf(Request);
    expect((rewritten as Request).url).toBe("http://localhost:8000/api/messages?beta=true");
    expect(await (rewritten as Request).text()).toBe("request-body");
    expect(() =>
      subscriptionRequestUrl(
        "https://elsewhere.example/v1/messages",
        "https://api.example/v1",
        "http://localhost:8000/api",
      ),
    ).toThrow("does not match");
  });
});
