import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import {
  EventId,
  McpServerId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, describe, expect, vi } from "vite-plus/test";
import { ServerConfig } from "../../config.ts";
import { AgentController } from "../Services/AgentController.ts";
import { LegacyProviderBridge } from "../Services/LegacyProviderBridge.ts";
import {
  createAkeruMastraAuthStorage,
  agentControllerLayerWith,
  recordProviderAccessHealth,
  toMcpServerConfigs,
} from "./AgentController.ts";
import { makeTestSubscriptionAuthService } from "../../subscription-auth/testUtils/subscriptionAuthService.ts";
import { BotUsageLedger } from "../../usage/BotUsageLedger.ts";
import { withMcpRuntimeHeaders } from "../McpServerConfig.ts";
import {
  codexThreadId,
  codexInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { usageLedgerFixture } from "./test-support/agentControllerMemory.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";

describe("toMcpServerConfigs", () => {
  it("attaches browser metadata only to dependent connectors and preserves authentication", () => {
    const server = withMcpRuntimeHeaders(
      {
        id: McpServerId.make("builtin-tinyfish"),
        name: "TinyFish",
        transport: "url" as const,
        url: "https://example.com/mcp",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      { Authorization: "Bearer fixture" },
    );

    const browser = {
      browserUrl: "https://sandbox.example/browser",
      mcpSessionId: "session",
      requestHeaders: { "sandbox-key": "remote" },
      localRequestHeaders: { "sandbox-key": "local" },
      availableToHostedPlugins: true,
    };

    const local = { ...server, transport: "stdio" as const, command: "executor" };
    expect(toMcpServerConfigs([server], browser)[server.id]).toEqual({
      url: server.url,
      headers: {
        Authorization: "Bearer fixture",
        "x-akeru-browser-mcp-url": browser.browserUrl,
        "x-akeru-browser-mcp-session-id": "session",
        "x-akeru-browser-mcp-headers": JSON.stringify(browser.requestHeaders),
      },
    });
    expect(toMcpServerConfigs([local], browser)[server.id]).toMatchObject({
      env: { AKERU_BROWSER_MCP_HEADERS: JSON.stringify(browser.localRequestHeaders) },
    });
    expect(
      toMcpServerConfigs([server], { ...browser, availableToHostedPlugins: false })[server.id],
    ).toEqual({
      url: server.url,
      headers: { Authorization: "Bearer fixture" },
    });
    const unrelated = { ...local, id: McpServerId.make("builtin-exa") };
    expect(toMcpServerConfigs([unrelated], browser)[unrelated.id]).not.toHaveProperty("env");
    expect(
      toMcpServerConfigs([{ ...server, enabled: false }], browser)[server.id],
    ).not.toHaveProperty("headers");
  });
});

describe("provider access health", () => {
  it.each([
    ["codex", "openai-codex"],
    ["claudeAgent", "anthropic"],
    ["grok", "xai"],
    ["kimi", "kimi-for-coding"],
  ] as const)("maps %s runtime requests to %s access health", async (driver, provider) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-map-"));
    const authPath = NodePath.join(directory, "subscription-auth.json");

    try {
      NodeFS.writeFileSync(
        authPath,
        JSON.stringify({
          [provider]: { type: "oauth", access: "a", refresh: "r", expires: 1_900_000_000_000 },
        }),
      );
      const service = await makeTestSubscriptionAuthService(authPath);
      // The default instance reports as the provider-level account.
      const providerInstanceId = ProviderInstanceId.make(driver);

      const base = {
        provider: ProviderDriverKind.make(driver),
        providerInstanceId,
        threadId: ThreadId.make(`thread-${driver}`),
      };

      recordProviderAccessHealth(service, {
        ...base,
        type: "runtime.error",
        eventId: EventId.make(`evt-${driver}-failed`),
        createdAt: "2026-08-30T20:00:00.000Z",
        payload: { message: "The first request failed.", class: "provider_error" },
      });
      expect(
        service.statuses([], 1_800_000_000_000).find((item) => item.provider === provider),
      ).toMatchObject({ health: "failed-first-request" });
      expect(service.providerInstanceHealth(providerInstanceId)).toBe("failed-first-request");

      recordProviderAccessHealth(service, {
        ...base,
        type: "turn.completed",
        eventId: EventId.make(`evt-${driver}-recovered`),
        createdAt: "2026-08-30T20:01:00.000Z",
        turnId: TurnId.make(`turn-${driver}`),
        payload: { state: "completed", stopReason: null },
      });
      expect(
        service.statuses([], 1_800_000_000_000).find((item) => item.provider === provider),
      ).toMatchObject({ health: "recovered" });
      expect(service.providerInstanceHealth(providerInstanceId)).toBe("recovered");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("AgentControllerLive", () => {
  it.effect("reads Akeru subscription credentials through Mastra AuthStorage", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const authPath = NodePath.join(config.secretsDir, "subscription-auth.json");
      yield* Effect.sync(() => {
        NodeFS.mkdirSync(config.secretsDir, { recursive: true });
        NodeFS.writeFileSync(
          authPath,
          JSON.stringify({
            "openai-codex": {
              type: "oauth",
              access: "subscription-access",
              refresh: "subscription-refresh",
              expires: 4_102_444_800_000,
              accountId: "account-123",
            },
          }),
        );
      });

      const auth = createAkeruMastraAuthStorage(config.secretsDir);
      assert.deepEqual(auth.get("openai-codex"), {
        type: "oauth",
        access: "subscription-access",
        refresh: "subscription-refresh",
        expires: 4_102_444_800_000,
        accountId: "account-123",
      });
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-mastra-auth-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("AgentControllerLive", () => {
  it.effect("passes Akeru subscription auth and memory storage to the custom harness", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        yield* AgentController;
        const options = mastra.harnessOptions[0];
        assert.isDefined(options);
        assert.isDefined(options.authStorage);
        assert.match(options.memoryDbPath, /mastra-observational-memory\.sqlite$/);
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("preserves the Railway VM when an active session rotates credentials", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const destroy = vi.fn(async () => undefined);

    const makeRemoteWorkspace = vi.fn(
      async (_input: import("../botWorkspace.ts").CreateRemoteBotWorkspaceInput) => ({
        id: "railway-vm",
        provider: "railway" as const,
        workspace: new Workspace({
          filesystem: new LocalFilesystem({ basePath: process.cwd() }),
          sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
        }),
        inspect: async () => "running" as const,
        wake: async () => undefined,
        sleep: async () => undefined,
        destroy,
      }),
    );

    const layer = agentControllerLayerWith({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, usageLedgerFixture().service),
          ServerConfig.layerTest(process.cwd(), { prefix: "akeru-railway-rotation-test-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
        ),
      ),
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);

      const input = {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        modelSelection: codexSelection,
        runtimeMode: "full-access" as const,
        botSandbox: "railway" as const,
      };

      for (const token of ["old", "new"]) {
        yield* controller.startSession(codexThreadId, {
          ...input,
          botSandboxEnvironment: { RAILWAY_API_TOKEN: token, RAILWAY_ENVIRONMENT_ID: "env" },
        });
      }

      expect(makeRemoteWorkspace).toHaveBeenCalledTimes(2);
      expect(makeRemoteWorkspace.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          workspaceId: makeRemoteWorkspace.mock.calls[1]?.[0]?.workspaceId,
        }),
      );
      expect(destroy).not.toHaveBeenCalled();
      yield* controller.startSession(codexThreadId, { ...input, botSandbox: "upstash" });
      expect(destroy).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer), Effect.orDie);
  });
});
