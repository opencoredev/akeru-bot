// @effect-diagnostics nodeBuiltinImport:off - This test inspects installed package artifacts on disk.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { InMemoryOAuthStorage, MCPOAuthClientProvider } from "@mastra/mcp";
import { auth } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vite-plus/test";

const requirePackage = NodeModule.createRequire(import.meta.url);
const packageEntry = requirePackage.resolve("@mastra/mcp");
const packageRoot = NodePath.dirname(NodePath.dirname(packageEntry));

function readPackageFile(path: string): string {
  return NodeFS.readFileSync(NodePath.join(packageRoot, path), "utf8");
}

const commonJsMcp = requirePackage("@mastra/mcp") as typeof import("@mastra/mcp");
const commonJsClient = requirePackage(
  "@modelcontextprotocol/client",
) as typeof import("@modelcontextprotocol/client");
const runtimes = [
  { name: "ESM", InMemoryOAuthStorage, MCPOAuthClientProvider, auth },
  { name: "CommonJS", ...commonJsMcp, auth: commonJsClient.auth },
];

const issuer = "https://oauth.example.test";
const resourceUrl = "https://mcp.example.test/mcp";
const redirectUrl = "http://127.0.0.1:1458/oauth/callback";
const oldScope = "openid offline_access thread:read";
const currentScope = `${oldScope} thread:update`;

function oauthFixture(options: {
  registeredScope?: string | undefined;
  staticClient?: boolean;
  registrationScope?: string;
  expiredRefreshToken?: boolean;
  runtime: (typeof runtimes)[number];
}) {
  const storage = new options.runtime.InMemoryOAuthStorage();
  const clientMetadata = {
    redirect_uris: [redirectUrl],
    client_name: "Akeru OAuth test",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  const clientInformation = {
    ...clientMetadata,
    client_id: "cached-client",
    issuer,
    ...(options.registeredScope === undefined ? {} : { scope: options.registeredScope }),
  };
  storage.set("client_info", JSON.stringify(clientInformation));
  if (options.expiredRefreshToken) {
    storage.set(
      "tokens",
      JSON.stringify({
        access_token: "expired-access-token",
        refresh_token: "expired-refresh-token",
        token_type: "Bearer",
        issuer,
      }),
    );
  }
  const onRedirectToAuthorization = vi.fn<(url: URL) => void>();
  const provider = new options.runtime.MCPOAuthClientProvider({
    redirectUrl,
    clientMetadata,
    storage,
    ...(options.staticClient ? { clientInformation } : {}),
    onRedirectToAuthorization,
  });
  const registrations: Record<string, unknown>[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === `${resourceUrl}/metadata`) {
      return Response.json({
        resource: resourceUrl,
        authorization_servers: [issuer],
        scopes_supported: currentScope.split(" "),
      });
    }
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: currentScope.split(" "),
      });
    }
    if (url === `${issuer}/token` && options.expiredRefreshToken) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url === `${issuer}/register`) {
      const metadata = JSON.parse(String(init?.body)) as Record<string, unknown>;
      registrations.push(metadata);
      return Response.json(
        {
          ...metadata,
          client_id: "new-client",
          ...(options.registrationScope === undefined ? {} : { scope: options.registrationScope }),
        },
        { status: 201 },
      );
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  };
  const authorize = () =>
    options.runtime.auth(provider, {
      serverUrl: resourceUrl,
      resourceMetadataUrl: new URL(`${resourceUrl}/metadata`),
      fetchFn,
    });
  return { provider, storage, registrations, onRedirectToAuthorization, authorize };
}

describe.each(runtimes)("@mastra/mcp OAuth registration scopes ($name)", (runtime) => {
  it("re-registers a cached client before requesting a newly advertised scope", async () => {
    const fixture = oauthFixture({ runtime, registeredScope: oldScope });
    await fixture.storage.set(
      "tokens",
      JSON.stringify({ access_token: "old-access-token", token_type: "Bearer", issuer }),
    );
    const state = await fixture.provider.beginAuthorizationSession();
    await expect(fixture.authorize()).resolves.toBe("REDIRECT");
    expect(await fixture.provider.tokens()).toBeUndefined();
    expect(await fixture.provider.state()).toBe(state);
    expect(fixture.registrations).toHaveLength(1);
    expect(fixture.registrations[0]?.scope).toBe(currentScope);
    expect(fixture.onRedirectToAuthorization).toHaveBeenCalledOnce();
    const url = fixture.onRedirectToAuthorization.mock.calls[0]?.[0];
    expect(url?.searchParams.get("client_id")).toBe("new-client");
    expect(url?.searchParams.get("scope")).toBe(currentScope);
    expect(url?.searchParams.get("code_challenge_method")).toBe("S256");
    expect((await fixture.provider.clientInformation())?.client_id).toBe("new-client");
    expect(JSON.parse(String(await fixture.storage.get("client_info"))).scope).toBe(currentScope);
  });

  it("recovers a stale registration even after an expired refresh token", async () => {
    const fixture = oauthFixture({ runtime, registeredScope: oldScope, expiredRefreshToken: true });
    await expect(fixture.authorize()).resolves.toBe("REDIRECT");
    expect(fixture.registrations).toHaveLength(1);
    expect(fixture.onRedirectToAuthorization).toHaveBeenCalledOnce();
    expect((await fixture.provider.clientInformation())?.client_id).toBe("new-client");
    expect(await fixture.provider.tokens()).toBeUndefined();
  });

  it.each([currentScope, `${currentScope} project:read`, undefined])(
    "preserves compatible or unspecified registered scopes: %s",
    async (registeredScope) => {
      const fixture = oauthFixture({ runtime, registeredScope });
      await expect(fixture.authorize()).resolves.toBe("REDIRECT");
      expect(fixture.registrations).toHaveLength(0);
      expect(fixture.onRedirectToAuthorization).toHaveBeenCalledOnce();
    },
  );

  it("leaves explicitly configured clients under their owner's control", async () => {
    const fixture = oauthFixture({ runtime, registeredScope: oldScope, staticClient: true });
    await expect(fixture.authorize()).resolves.toBe("REDIRECT");
    expect(fixture.registrations).toHaveLength(0);
    expect((await fixture.provider.clientInformation())?.client_id).toBe("cached-client");
  });

  it.each([false, true])(
    "stops after one rejected registration retry with expired refresh token: %s",
    async (expiredRefreshToken) => {
      const fixture = oauthFixture({
        runtime,
        registeredScope: oldScope,
        registrationScope: oldScope,
        expiredRefreshToken,
      });
      await expect(fixture.authorize()).rejects.toThrow("registered scopes");
      expect(fixture.registrations).toHaveLength(1);
      expect(fixture.onRedirectToAuthorization).not.toHaveBeenCalled();
    },
  );
});

describe("@mastra/mcp OAuth issuer patch", () => {
  it("forwards the authorization issuer from the callback to the MCP transport", () => {
    for (const bundle of ["dist/index.js", "dist/index.cjs"]) {
      const source = readPackageFile(bundle);
      expect(source).toContain('iss: url.searchParams.get("iss") ?? void 0');
      expect(source).toContain("const { code, iss } = await callbackServer.waitForCode(options)");
      expect(source).toContain("await client.finishAuth(code, iss)");
      expect(source).toContain("await pending.finishAuth(authorizationCode, iss)");
    }

    expect(readPackageFile("dist/client/client.d.ts")).toContain(
      "finishAuth(authorizationCode: string, iss?: string): Promise<void>",
    );
    expect(readPackageFile("dist/client/oauth-callback-server.d.ts")).toContain("iss?: string");
  });
});
