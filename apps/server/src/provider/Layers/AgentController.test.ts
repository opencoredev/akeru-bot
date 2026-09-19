// @effect-diagnostics globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentControllerEvent, MastraDBMessage, Session } from "@mastra/core/agent-controller";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  ApprovalRequestId,
  BotId,
  EnvironmentId,
  EventId,
  GroupId,
  McpServerId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type AkeruDelegationAccessGrant,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, describe, expect, vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { BotInboxService } from "../../bot-inbox/service.ts";
import { BotMemoryStore } from "../../memory/BotMemory.ts";
import { createBotMemoryToolHandler } from "../../memory/BotMemoryToolHandlers.ts";
import { EntityMemoryRepository } from "../../memory/Services/EntityMemoryRepository.ts";
import * as McpMemoryToolSession from "../../mcp/McpMemoryToolSession.ts";
import { AgentController } from "../Services/AgentController.ts";
import { ProviderValidationError } from "../Errors.ts";
import { LegacyProviderBridge } from "../Services/LegacyProviderBridge.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  createAkeruMastraAuthStorage,
  delegatedUsageReceipt,
  makeAgentControllerLive,
  mastraConnectionIssue,
  mcpServerIdForToolName,
  recordProviderAccessHealth,
  toMcpServerConfigs,
  type AgentControllerLiveOptions,
} from "./AgentController.ts";
import { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import {
  BotUsageCapExceeded,
  BotUsageLedger,
  type BotUsageLedgerShape,
} from "../../usage/BotUsageLedger.ts";
import { withMcpRuntimeHeaders } from "../McpServerConfig.ts";

const codexThreadId = ThreadId.make("thread-mastra-codex");
const claudeThreadId = ThreadId.make("thread-mastra-claude");
const grokThreadId = ThreadId.make("thread-mastra-grok");
const kimiThreadId = ThreadId.make("thread-mastra-kimi");
const openCodeGoThreadId = ThreadId.make("thread-mastra-opencode-go");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const grokInstanceId = ProviderInstanceId.make("grok");
const openCodeInstanceId = ProviderInstanceId.make("opencode");
const kimiInstanceId = ProviderInstanceId.make("kimi-custom");
const openCodeGoInstanceId = ProviderInstanceId.make("opencodeGo");

const codexSelection = {
  instanceId: codexInstanceId,
  model: "gpt-5.6-sol",
};
const computerUseToolName = "builtin-computer-use_control";

describe("mastraConnectionIssue", () => {
  it("uses the exact instance transport when deciding readiness", () => {
    assert.isUndefined(
      mastraConnectionIssue(
        ProviderDriverKind.make("grok"),
        {
          environment: { XAI_API_KEY: "ambient-key" },
          instanceEnvironment: { XAI_API_KEY: "instance-key" },
          useSavedCredential: false,
        },
        false,
      ),
    );
    assert.include(
      mastraConnectionIssue(
        ProviderDriverKind.make("grok"),
        {
          environment: { XAI_API_KEY: "ambient-key" },
          instanceEnvironment: {},
          useSavedCredential: false,
        },
        true,
      ) ?? "",
      "XAI_API_KEY",
    );
  });

  it("requires the provider-wide connection only when the instance opted into it", () => {
    const connection = { environment: {}, instanceEnvironment: {}, useSavedCredential: true };
    assert.isUndefined(
      mastraConnectionIssue(ProviderDriverKind.make("claudeAgent"), connection, true),
    );
    assert.include(
      mastraConnectionIssue(ProviderDriverKind.make("claudeAgent"), connection, false) ?? "",
      "Connect",
    );
  });

  it.each([
    [ProviderDriverKind.make("codex"), { OPENAI_API_KEY: "ambient-key" }],
    [ProviderDriverKind.make("claudeAgent"), { ANTHROPIC_API_KEY: "ambient-key" }],
    [ProviderDriverKind.make("grok"), { XAI_API_KEY: "ambient-key" }],
    [ProviderDriverKind.make("opencodeGo"), { OPENCODE_API_KEY: "ambient-key" }],
  ] as const)("accepts ambient credentials for %s without a saved connection", (provider, env) => {
    assert.isUndefined(
      mastraConnectionIssue(
        provider,
        { environment: env, instanceEnvironment: {}, useSavedCredential: true },
        false,
      ),
    );
  });

  it("accepts an isolated OpenCode Go inline credential", () => {
    const environment = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          "opencode-go": {
            options: { apiKey: "inline-key", baseURL: "https://inline.example/v1" },
          },
        },
      }),
    };
    assert.isUndefined(
      mastraConnectionIssue(
        ProviderDriverKind.make("opencodeGo"),
        { environment, instanceEnvironment: environment, useSavedCredential: false },
        false,
      ),
    );
  });
});

function computerUseServer() {
  return {
    id: McpServerId.make("builtin-computer-use"),
    name: "Codex Computer Use",
    transport: "stdio" as const,
    command: "akeru-codex-computer-use",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function computerUseMcpManager() {
  return {
    init: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    getTools: vi.fn(() => ({
      [computerUseToolName]: { execute: vi.fn(async () => ({})) },
    })),
    getServerStatuses: vi.fn(() => [
      {
        name: "builtin-computer-use",
        connected: true,
        toolCount: 1,
        toolNames: [computerUseToolName],
        transport: "stdio" as const,
      },
    ]),
  };
}

function makeProviderSession(
  threadId: ThreadId,
  provider: "codex" | "claudeAgent",
): ProviderSession {
  return {
    provider: ProviderDriverKind.make(provider),
    providerInstanceId: ProviderInstanceId.make(provider),
    threadId,
    status: "ready",
    runtimeMode: "full-access",
    model: provider === "codex" ? "gpt-5.6-sol" : "claude-fable-5",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function completeLegacyTurnWithMemoryReview(
  input: Parameters<ProviderServiceShape["sendTurn"]>[0],
  turnId: TurnId,
  successfulMemoryCalls = 1,
) {
  return Effect.promise(async () => {
    if (input.persistentMemoryContext?.includes("<automatic-memory-review>")) {
      const handler = McpMemoryToolSession.readMcpMemoryToolSession(input.threadId);
      if (!handler) throw new Error("Foreground memory review handler was not registered.");
      for (let call = 0; call < successfulMemoryCalls; call += 1) {
        await handler({
          threadId: String(input.threadId),
          toolId: "memory",
          toolCallId: `foreground-memory-review-${String(turnId)}-${call}`,
          input: { target: "user", operations: [] },
          approvalMode: "require-grant",
        });
      }
    }
    return { threadId: input.threadId, turnId };
  });
}

function makeBridge() {
  let instanceEnabled = true;
  let disableBeforeNextDispatchAdmission = false;
  let nextDispatchAdmissionWait: Promise<void> | undefined;
  let releaseNextDispatchAdmission: (() => void) | undefined;
  let nextDispatchAdmissionReached = Promise.resolve();
  let markNextDispatchAdmissionReached: (() => void) | undefined;
  const startSession = vi.fn<ProviderServiceShape["startSession"]>((threadId, input) =>
    Effect.succeed(
      makeProviderSession(threadId, String(input.provider) === "codex" ? "codex" : "claudeAgent"),
    ),
  );
  const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((input) =>
    Effect.succeed({ threadId: input.threadId, turnId: TurnId.make("legacy-turn") }),
  );
  const interruptTurn = vi.fn<ProviderServiceShape["interruptTurn"]>(() => Effect.void);
  const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
  const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
  const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
  const rollbackConversation = vi.fn<ProviderServiceShape["rollbackConversation"]>(
    () => Effect.void,
  );
  const getCapabilities = vi.fn<ProviderServiceShape["getCapabilities"]>(() =>
    Effect.succeed({ sessionModelSwitch: "in-session" }),
  );
  const service: ProviderServiceShape = {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    rollbackConversation,
    listSessions: () => Effect.succeed([]),
    getCapabilities,
    getInstanceInfo: (instanceId) =>
      Effect.sync(() => {
        const driverKind = ProviderDriverKind.make(
          instanceId === kimiInstanceId ? "kimi" : String(instanceId),
        );
        return {
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: instanceEnabled,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        };
      }),
    dispatchIfEnabled: (instanceId, operation, dispatch) => {
      const dispatchNow = () => {
        if (disableBeforeNextDispatchAdmission) {
          disableBeforeNextDispatchAdmission = false;
          instanceEnabled = false;
        }
        return instanceEnabled
          ? Effect.sync(dispatch)
          : Effect.fail(
              new ProviderValidationError({
                operation,
                issue: `Provider instance '${instanceId}' is disabled in Akeru Bot settings.`,
              }),
            );
      };
      return Effect.suspend(() => {
        const wait = nextDispatchAdmissionWait;
        nextDispatchAdmissionWait = undefined;
        markNextDispatchAdmissionReached?.();
        markNextDispatchAdmissionReached = undefined;
        return wait ? Effect.promise(() => wait).pipe(Effect.flatMap(dispatchNow)) : dispatchNow();
      });
    },
    uploadFeedback: (input) => Effect.succeed({ feedbackId: `feedback-${String(input.threadId)}` }),
    streamEvents: Stream.empty,
  };
  return {
    service,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    rollbackConversation,
    getCapabilities,
    setInstanceEnabled: (enabled: boolean) => {
      instanceEnabled = enabled;
    },
    disableBeforeNextDispatchAdmission: () => {
      disableBeforeNextDispatchAdmission = true;
    },
    blockNextDispatchAdmission: () => {
      nextDispatchAdmissionWait = new Promise<void>((resolve) => {
        releaseNextDispatchAdmission = resolve;
      });
      nextDispatchAdmissionReached = new Promise<void>((resolve) => {
        markNextDispatchAdmissionReached = resolve;
      });
    },
    waitForNextDispatchAdmission: () => nextDispatchAdmissionReached,
    releaseNextDispatchAdmission: () => {
      releaseNextDispatchAdmission?.();
      releaseNextDispatchAdmission = undefined;
    },
  };
}

function makeMemoryOnlyCredentialOptions() {
  const requests: Array<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly capabilities?: ReadonlySet<"preview" | "memory">;
  }> = [];
  const revoked: Array<ThreadId> = [];
  return {
    requests,
    revoked,
    issueMcpCredential: (request: (typeof requests)[number]) => {
      requests.push(request);
      if (request.capabilities?.has("preview")) return Effect.succeed(undefined);
      return Effect.succeed({
        config: {
          environmentId: EnvironmentId.make("environment-test"),
          threadId: request.threadId,
          providerSessionId: `session-${String(request.threadId)}`,
          providerInstanceId: request.providerInstanceId,
          endpoint: "http://127.0.0.1:1/mcp",
          authorizationHeader: "Bearer test-memory-only",
        },
      });
    },
    revokeMcpCredential: (threadId: ThreadId) =>
      Effect.sync(() => {
        revoked.push(threadId);
      }),
  };
}

function makeUsageLedger() {
  const reserve = vi.fn<BotUsageLedgerShape["reserve"]>(() => Effect.succeed({} as never));
  const settle = vi.fn<BotUsageLedgerShape["settle"]>(() => Effect.succeed({} as never));
  const unused = () => Effect.die("unused");
  return {
    reserve,
    settle,
    service: BotUsageLedger.of({
      reserve,
      settle,
      bindTurn: unused,
      settleForTurn: unused,
      finalizeForTurn: unused,
      recordMeasurement: unused,
      summarize: unused,
    }),
  };
}

function makeMastraHarness() {
  const harnessOptions: Array<
    Parameters<NonNullable<AgentControllerLiveOptions["makeMastraHarness"]>>[0]
  > = [];
  const listeners = new Set<(event: AgentControllerEvent) => void>();
  let modeId = "build";
  let modelId = "openai/gpt-5.6-sol";
  let state: Record<string, unknown> = {};
  let resolveSend: (() => void) | undefined;
  const rejectSends: Array<(cause: unknown) => void> = [];
  let sendMessageCount = 0;
  const sendMessageWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  const sendMessage = vi.fn(() => {
    sendMessageCount += 1;
    for (const waiter of sendMessageWaiters.splice(0)) {
      if (sendMessageCount >= waiter.count) waiter.resolve();
      else sendMessageWaiters.push(waiter);
    }
    return new Promise<void>((resolve, reject) => {
      resolveSend = resolve;
      rejectSends.push(reject);
    });
  });
  const session = {
    state: {
      get: () => state,
      set: vi.fn(async (next: Record<string, unknown>) => {
        state = next;
      }),
    },
    mode: {
      get: () => modeId,
      switch: vi.fn(async ({ modeId: next }: { readonly modeId: string }) => {
        modeId = next;
      }),
    },
    model: {
      get: () => modelId,
      switch: vi.fn(async ({ modelId: next }: { readonly modelId: string }) => {
        modelId = next;
      }),
    },
    permissions: {
      setForCategory: vi.fn(async () => undefined),
      setForTool: vi.fn(async () => undefined),
    },
    grantTool: vi.fn(),
    subscribe: vi.fn((listener: (event: AgentControllerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    sendMessage,
    abort: vi.fn(),
    respondToToolApproval: vi.fn(),
    respondToToolSuspension: vi.fn(async () => undefined),
  } as unknown as Session<Record<string, unknown>>;
  const createSession = vi.fn(async (_input: unknown) => session as never);
  const deleteSession = vi.fn(async () => true);
  const destroy = vi.fn(async () => undefined);
  const observeExternalTurn = vi.fn(async () => undefined);
  const factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]> = async (options) => {
    harnessOptions.push(options);
    return {
      controller: {
        init: vi.fn(async () => undefined),
        createSession,
        deleteSession,
        destroy,
      },
      observeExternalTurn,
      destroy: vi.fn(),
    };
  };
  const emit = (event: AgentControllerEvent) => {
    for (const listener of listeners) listener(event);
  };
  return {
    factory,
    harnessOptions,
    session,
    createSession,
    deleteSession,
    sendMessage,
    observeExternalTurn,
    emit,
    waitForSendMessageCount: (count: number) =>
      sendMessageCount >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => sendMessageWaiters.push({ count, resolve })),
    finishSend: () => resolveSend?.(),
    rejectSend: (index: number, cause: unknown) => rejectSends[index]?.(cause),
    failSend: (cause: unknown) => rejectSends.at(-1)?.(cause),
  };
}

function assistantMessage(text: string, id = "assistant-message"): MastraDBMessage {
  return {
    id,
    role: "assistant",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    content: {
      format: 2,
      parts: [{ type: "text", text }],
    },
    threadId: String(codexThreadId),
    resourceId: String(codexThreadId),
  } as MastraDBMessage;
}

function makeLayer(
  bridge: ProviderServiceShape,
  factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]>,
  makeMcpManager?: NonNullable<AgentControllerLiveOptions["makeMcpManager"]>,
  baseDir?: string,
  usageLedger: BotUsageLedgerShape = makeUsageLedger().service,
  overrides?: Pick<
    AgentControllerLiveOptions,
    | "resolveComputerUseServer"
    | "entityMemoryRepository"
    | "issueMcpCredential"
    | "revokeMcpCredential"
    | "makeBotBrowser"
    | "botMemoryStore"
  >,
  delegationRuntime?: AgentControllerLiveOptions["delegationRuntime"],
) {
  return makeAgentControllerLive({
    makeMastraHarness: factory,
    ...(makeMcpManager ? { makeMcpManager } : {}),
    ...overrides,
    ...(delegationRuntime ? { delegationRuntime } : {}),
    makeBotBrowser:
      overrides?.makeBotBrowser ??
      (() => ({
        tools: {},
        attachment: async () => undefined,
        reconnect: async () => undefined,
        close: async () => undefined,
      })),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(LegacyProviderBridge, bridge),
        Layer.succeed(BotUsageLedger, usageLedger),
        Layer.mock(EntityMemoryRepository)({}),
        ServerConfig.layerTest(
          process.cwd(),
          baseDir ?? { prefix: "akeru-mastra-controller-test-" },
        ).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
}

function provideController<A, E>(
  effect: Effect.Effect<A, E, AgentController>,
  bridge: ProviderServiceShape,
  factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]>,
  makeMcpManager?: NonNullable<AgentControllerLiveOptions["makeMcpManager"]>,
  baseDir?: string,
  usageLedger?: BotUsageLedgerShape,
  overrides?: Pick<
    AgentControllerLiveOptions,
    | "resolveComputerUseServer"
    | "entityMemoryRepository"
    | "issueMcpCredential"
    | "revokeMcpCredential"
    | "makeBotBrowser"
    | "botMemoryStore"
  >,
) {
  return effect.pipe(
    Effect.provide(makeLayer(bridge, factory, makeMcpManager, baseDir, usageLedger, overrides)),
    Effect.orDie,
  );
}

function resolveCodex(controller: AgentController["Service"]) {
  return controller.resolveEngine({
    threadId: codexThreadId,
    engine: { provider: "codex", model: "gpt-5.6-sol" },
    fallback: codexSelection,
    mode: "default",
    botConversation: true,
  });
}

describe("toMcpServerConfigs", () => {
  it("attributes namespaced MCP tools to the exact server id", () => {
    expect(
      mcpServerIdForToolName(
        [McpServerId.make("builtin-exa"), McpServerId.make("builtin-exa-search")],
        "builtin-exa-search_find",
      ),
    ).toBe("builtin-exa-search");
    expect(mcpServerIdForToolName([McpServerId.make("builtin-exa")], "read_file")).toBeUndefined();
  });

  it("converts only the bot's filtered MCP registrations for Mastra", () => {
    expect(
      toMcpServerConfigs([
        {
          id: McpServerId.make("builtin-exa"),
          name: "Exa",
          transport: "url",
          url: "https://mcp.exa.ai/mcp",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: McpServerId.make("local-tools"),
          name: "Local tools",
          transport: "stdio",
          command: "bunx",
          args: ["local-tools"],
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    ).toEqual({
      "builtin-exa": { url: "https://mcp.exa.ai/mcp" },
      "local-tools": { command: "bunx", args: ["local-tools"] },
    });
  });

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

  it("forwards transient MCP headers without adding them to the server record", () => {
    const server = withMcpRuntimeHeaders(
      {
        id: McpServerId.make("composio-session"),
        name: "Composio",
        transport: "url" as const,
        url: "https://app.composio.dev/tool_router/v3/session/mcp",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      { "x-api-key": "project-key" },
    );

    expect(toMcpServerConfigs([server])).toEqual({
      "composio-session": {
        url: "https://app.composio.dev/tool_router/v3/session/mcp",
        headers: { "x-api-key": "project-key" },
      },
    });
    expect(server).not.toHaveProperty("headers");
  });
});

describe("provider access health", () => {
  it.each([
    ["codex", "openai-codex"],
    ["claudeAgent", "anthropic"],
    ["cursor", "cursor"],
    ["grok", "xai"],
    ["kimi", "kimi-for-coding"],
  ] as const)("maps %s runtime requests to %s access health", (driver, provider) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-map-"));
    const authPath = NodePath.join(directory, "subscription-auth.json");
    try {
      NodeFS.writeFileSync(
        authPath,
        JSON.stringify({
          [provider]: { type: "oauth", access: "a", refresh: "r", expires: 1_900_000_000_000 },
        }),
      );
      const service = new SubscriptionAuthService(authPath);
      const providerInstanceId = ProviderInstanceId.make(`instance-${driver}`);
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

  it("records a failed first request and recovery at the runtime event boundary", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-health-"));
    const authPath = NodePath.join(directory, "subscription-auth.json");
    try {
      NodeFS.writeFileSync(
        authPath,
        JSON.stringify({
          xai: { type: "oauth", access: "a", refresh: "r", expires: 1_900_000_000_000 },
        }),
      );
      const service = new SubscriptionAuthService(authPath);
      const base = {
        provider: ProviderDriverKind.make("grok"),
        providerInstanceId: ProviderInstanceId.make("grok"),
        threadId: ThreadId.make("thread-health"),
      };
      recordProviderAccessHealth(service, {
        ...base,
        type: "runtime.error",
        eventId: EventId.make("evt-health-failed"),
        createdAt: "2026-08-30T20:00:00.000Z",
        payload: { message: "The first request failed.", class: "provider_error" },
      });
      expect(
        service.statuses([], 1_800_000_000_000).find((item) => item.provider === "xai")?.health,
      ).toBe("failed-first-request");
      expect(service.providerInstanceHealth("grok")).toBe("failed-first-request");

      recordProviderAccessHealth(service, {
        ...base,
        type: "turn.completed",
        eventId: EventId.make("evt-health-recovered"),
        createdAt: "2026-08-30T20:01:00.000Z",
        turnId: TurnId.make("turn-health"),
        payload: { state: "completed", stopReason: null },
      });
      expect(
        service.statuses([], 1_800_000_000_000).find((item) => item.provider === "xai")?.health,
      ).toBe("recovered");
      expect(service.providerInstanceHealth("grok")).toBe("recovered");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["interrupted", "cancelled"] as const)(
    "does not call a %s turn a successful provider request",
    (state) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-stop-"));
      const authPath = NodePath.join(directory, "subscription-auth.json");
      try {
        const service = new SubscriptionAuthService(authPath);
        recordProviderAccessHealth(service, {
          provider: ProviderDriverKind.make("grok"),
          providerInstanceId: ProviderInstanceId.make("grok"),
          threadId: ThreadId.make("thread-stopped"),
          turnId: TurnId.make("turn-stopped"),
          type: "turn.completed",
          eventId: EventId.make(`evt-health-${state}`),
          createdAt: "2026-08-30T20:00:00.000Z",
          payload: { state, stopReason: null },
        });

        expect(service.providerInstanceHealth("grok")).toBeUndefined();
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("AgentControllerLive", () => {
  for (const provider of [
    "codex",
    "kimi",
    "opencodeGo",
    "claudeAgent",
    "grok",
    "opencode",
  ] as const) {
    it.effect(`keeps unrelated connector browser acquisition lazy for ${provider}`, () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const attachment = vi.fn(async () => undefined);
      const manager = {
        init: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        getTools: () => ({}),
        getServerStatuses: () => [],
      };
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const threadId = ThreadId.make(`lazy-${provider}`);
          const instanceId = ProviderInstanceId.make(provider);
          const selection = { instanceId, model: "fixture-model" };
          yield* controller.resolveEngine({
            threadId,
            engine: null,
            fallback: selection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(threadId, {
            threadId,
            provider: ProviderDriverKind.make(provider),
            providerInstanceId: instanceId,
            modelSelection: selection,
            runtimeMode: "full-access",
            mcpServers: [
              {
                id: McpServerId.make("builtin-exa"),
                name: "Exa",
                transport: "url",
                url: "https://mcp.exa.ai/mcp",
                enabled: true,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          });
          expect(attachment).not.toHaveBeenCalled();
          expect(manager.init).toHaveBeenCalledOnce();
          expect(bridge.startSession).toHaveBeenCalledTimes(provider === "opencode" ? 1 : 0);
          yield* controller.stopSession({ threadId });
        }),
        bridge.service,
        mastra.factory,
        () => manager as never,
        undefined,
        undefined,
        {
          makeBotBrowser: () => ({
            tools: {},
            attachment,
            reconnect: async () => undefined,
            close: async () => undefined,
          }),
        },
      );
    });
  }

  it("bills delegated usage receipts to the child bot", () => {
    const childBotId = BotId.make("bot-child");
    const childThreadId = ThreadId.make("thread-child");
    const childTurnId = TurnId.make("turn-child");
    const receipt = delegatedUsageReceipt(
      {
        botId: childBotId,
        threadId: childThreadId,
        turnId: childTurnId,
        category: "delegated",
        inputTokens: 12,
        outputTokens: 8,
      },
      { provider: ProviderDriverKind.make("codex"), providerInstanceId: codexInstanceId },
      "2026-01-01T00:00:00.000Z",
    );

    expect(receipt).toMatchObject({
      type: "tool.receipt",
      threadId: childThreadId,
      turnId: childTurnId,
      payload: {
        toolId: "SendToAgent",
        threadId: childThreadId,
        botId: childBotId,
        billedBotId: childBotId,
        fatalToThread: false,
        usage: { inputTokens: 12, outputTokens: 8 },
      },
    });
  });

  it.effect("runs parent-finished cleanup when a parent turn is interrupted", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const parentFinished = vi.fn(async () => undefined);
    const layer = makeLayer(
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        send: vi.fn(async () => null),
        sendToUser: vi.fn(async () => {
          throw new Error("not used");
        }),
        parentFinished,
        accessForThread: () => undefined,
      },
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: process.cwd(),
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
      });
      yield* controller.sendTurn({ threadId: codexThreadId, input: "Delegate work." });
      yield* controller.interruptTurn({ threadId: codexThreadId });
      yield* Effect.yieldNow;

      expect(parentFinished).toHaveBeenCalledWith({ threadId: codexThreadId, failed: false });
    }).pipe(Effect.provide(layer), Effect.orDie);
  });

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

  it.effect("passes Akeru subscription auth and memory storage to the custom harness", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
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

  it.effect("rejects conversation memory calls when the harness has no memory", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const readError = yield* controller.readConversationMemory!(codexThreadId).pipe(
          Effect.flip,
        );
        const clearError = yield* controller.clearConversationMemory!(codexThreadId).pipe(
          Effect.flip,
        );

        assert.deepInclude(readError, {
          _tag: "AgentControllerRuntimeError",
          operation: "memory.read",
        });
        assert.deepInclude(clearError, {
          _tag: "AgentControllerRuntimeError",
          operation: "memory.clear",
        });
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("registers the file-backed memory tool for Mastra sessions", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: codexThreadId,
      projectId: ProjectId.make("project-memory-tools"),
      workspaceRoot: "/workspace/memory-tools",
      botId: BotId.make("bot-memory-tools"),
      groupId: null,
      respondingBotId: BotId.make("bot-memory-tools"),
      groupMemberBotIds: [],
    } as const;
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          memoryAccess: access,
        });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).toEqual(
          expect.arrayContaining(["memory"]),
        );
        const result = yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "memory",
            toolCallId: "private-memory",
            input: {
              target: "user",
              operations: [{ action: "add", content: "The user prefers vim." }],
            },
            approvalMode: "require-grant",
          }),
        );
        expect(result).toMatchObject({ success: true, message: "Memory updated.", target: "user" });
        const recalled = yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "memory",
            toolCallId: "read-private-memory",
            input: { target: "user", operations: [] },
            approvalMode: "require-grant",
          }),
        );
        expect(recalled).toMatchObject({
          success: true,
          changed: false,
          content: "The user prefers vim.",
        });
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("keeps group memory tools bound to the admitted responding bot", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-group-tool-scope-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botA = BotId.make("bot-group-active-a");
    const botB = BotId.make("bot-group-queued-b");
    const groupId = GroupId.make("group-tool-scope");
    const accessFor = (botId: BotId) =>
      ({
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: codexThreadId,
        projectId: ProjectId.make("project-group-tool-scope"),
        workspaceRoot: "/workspace/group-tool-scope",
        botId,
        groupId,
        respondingBotId: botId,
        groupMemberBotIds: [botA, botB],
      }) as const;

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* Effect.promise(() =>
          botMemoryStore.mutate({
            ...accessFor(botB),
            target: "user",
            operations: [{ action: "add", content: "The user likes coffee." }],
          }),
        );
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          memoryAccess: accessFor(botA),
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Bot A turn." });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(1));

        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          memoryAccess: accessFor(botB),
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Bot B queued turn." });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "memory",
            toolCallId: "active-bot-group-memory",
            input: {
              target: "group",
              operations: [{ action: "add", content: "The group chose option A." }],
            },
            approvalMode: "require-grant",
          }),
        );

        const activeDocument = yield* Effect.promise(() =>
          botMemoryStore.readDocument(accessFor(botA), "group"),
        );
        const queuedDocument = yield* Effect.promise(() =>
          botMemoryStore.readDocument(accessFor(botB), "group"),
        );
        expect(activeDocument.content).toContain("The group chose option A.");
        expect(queuedDocument.content).not.toContain("The group chose option A.");

        mastra.finishSend();
        yield* Effect.promise(() => mastra.waitForSendMessageCount(2));
        expect(mastra.session.state.get()).toHaveProperty("persistentMemoryContext");
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Turn without memory access.",
        });
        mastra.finishSend();
        yield* Effect.promise(() => mastra.waitForSendMessageCount(3));
        expect(mastra.session.state.get()).not.toHaveProperty("persistentMemoryContext");
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).not.toContain(
          "memory",
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
      ),
    );
  });

  it.effect("releases a Mastra cadence reservation when admission is interrupted", () => {
    vi.useFakeTimers();
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-review-interrupt-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-review-interrupt");
    const renew = vi.spyOn(botMemoryStore, "renewReviewClaim");
    const reservationReached = Promise.withResolvers<void>();
    const reserve = botMemoryStore.reserveReviewCadence.bind(botMemoryStore);
    vi.spyOn(botMemoryStore, "reserveReviewCadence").mockImplementation(async (reservedBotId) => {
      const reservation = await reserve(reservedBotId);
      reservationReached.resolve();
      return reservation;
    });

    return provideController(
      Effect.gen(function* () {
        for (let prompt = 1; prompt <= 10; prompt += 1) {
          const reservation = yield* Effect.promise(() =>
            botMemoryStore.reserveReviewCadence(botId),
          );
          yield* Effect.promise(() => botMemoryStore.settleReviewCadence(reservation, true));
        }
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          memoryAccess: {
            tenantId: AkeruMemoryTenantId.make("local"),
            userId: AkeruMemoryUserId.make("owner"),
            threadId: codexThreadId,
            projectId: ProjectId.make("project-review-interrupt"),
            workspaceRoot: "/workspace/review-interrupt",
            botId,
            groupId: null,
            respondingBotId: botId,
            groupMemberBotIds: [],
          },
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Interrupt admission." });
        yield* Effect.promise(() => reservationReached.promise);
        yield* controller.interruptTurn({ threadId: codexThreadId });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
        expect(renew).not.toHaveBeenCalled();

        const anotherStore = new BotMemoryStore(memoryDir);
        const next = yield* Effect.promise(() => anotherStore.reserveReviewCadence(botId));
        yield* Effect.promise(() => anotherStore.settleReviewCadence(next, false));
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.useRealTimers();
          NodeFS.rmSync(memoryDir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect.each([0, 1, 2])(
    "settles a Mastra review only after one successful memory call (count: %s)",
    (successfulMemoryCalls) => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-mastra-review-"));
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-mastra-review");
      const access = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: codexThreadId,
        projectId: ProjectId.make("project-mastra-review"),
        workspaceRoot: "/workspace/mastra-review",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      } as const;

      return provideController(
        Effect.gen(function* () {
          for (let prompt = 1; prompt <= 10; prompt += 1) {
            const reservation = yield* Effect.promise(() =>
              botMemoryStore.reserveReviewCadence(botId),
            );
            yield* Effect.promise(() => botMemoryStore.settleReviewCadence(reservation, true));
          }
          const acceptedRecorded = Promise.withResolvers<void>();
          const settleReviewClaim = botMemoryStore.settleReviewClaim.bind(botMemoryStore);
          vi.spyOn(botMemoryStore, "settleReviewClaim").mockImplementation(async (...args) => {
            const result = await settleReviewClaim(...args);
            acceptedRecorded.resolve();
            return result;
          });
          const controller = yield* AgentController;
          yield* resolveCodex(controller);
          yield* controller.startSession(codexThreadId, {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            memoryAccess: access,
          });

          yield* controller.sendTurn({ threadId: codexThreadId, input: "The tenth prompt" });
          yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
          expect(mastra.session.state.set).toHaveBeenLastCalledWith(
            expect.objectContaining({
              persistentMemoryContext: expect.stringContaining("<automatic-memory-review>"),
            }),
          );
          expect(mastra.session.state.set).toHaveBeenLastCalledWith(
            expect.objectContaining({
              persistentMemoryContext: expect.stringContaining(
                "GROUP.md is not available in this chat",
              ),
            }),
          );

          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);
          for (let call = 0; call < successfulMemoryCalls; call += 1) {
            yield* Effect.promise(() =>
              runtime.execute({
                threadId: String(codexThreadId),
                toolId: "memory",
                toolCallId: `automatic-review-no-op-${call}`,
                input: { target: "user", operations: [] },
                approvalMode: "require-grant",
              }),
            );
          }

          mastra.finishSend();
          yield* Effect.promise(() => acceptedRecorded.promise);
          assert.deepEqual(yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId)), {
            acceptedPromptCount: 11,
            reviewedThroughPromptCount: successfulMemoryCalls === 1 ? 10 : 0,
            dueOnNextAcceptedPrompt: successfulMemoryCalls !== 1,
          });
        }),
        bridge.service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect("boots a real Mastra Code controller and creates a Codex session", () => {
    const bridge = makeBridge();
    const layer = makeAgentControllerLive().pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, makeUsageLedger().service),
          ServerConfig.layerTest(process.cwd(), {
            prefix: "akeru-mastra-real-controller-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      const session = yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: process.cwd(),
        modelSelection: codexSelection,
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "codex");
      assert.equal(session.model, "gpt-5.6-sol");
      yield* controller.stopSession({ threadId: codexThreadId });
      expect(bridge.startSession).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer), Effect.orDie);
  });

  it.effect("runs Codex turns through Mastra Session.sendMessage and normalizes events", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const session = yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        assert.equal(session.provider, "codex");

        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Reply once." });
        mastra.emit({
          type: "message_update",
          message: assistantMessage("Mastra"),
        } as AgentControllerEvent);
        mastra.emit({
          type: "message_end",
          message: assistantMessage("Mastra answer"),
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        assert.deepEqual(
          events.slice(0, 6).map((event) => event.type),
          [
            "turn.started",
            "session.state.changed",
            "item.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );
        assert.equal(
          events
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta)
            .join(""),
          "Mastra answer",
        );
        expect(mastra.sendMessage).toHaveBeenCalledWith({ content: "Reply once." });
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.sendTurn).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("keeps the current bot name in reused Mastra session state", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const input = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access" as const,
          botId: BotId.make("bot-one"),
        };

        yield* controller.startSession(codexThreadId, {
          ...input,
          botName: "Research bot",
          personalityTone: 20,
        });
        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({
            botConversation: true,
            botName: "Research bot",
            personalityTone: 20,
          }),
        );

        yield* controller.startSession(codexThreadId, {
          ...input,
          botName: "Mina",
          personalityTone: 80,
        });
        expect(mastra.createSession).toHaveBeenCalledOnce();
        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({
            botConversation: true,
            botName: "Mina",
            personalityTone: 80,
          }),
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("clears a stale bot name in reused Mastra session state", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const input = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access" as const,
          botId: BotId.make("bot-one"),
        };

        yield* controller.startSession(codexThreadId, { ...input, botName: "Research bot" });
        yield* controller.startSession(codexThreadId, input);
        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({ botConversation: true, botName: "" }),
        );

        yield* controller.startSession(codexThreadId, { ...input, botName: "Research bot" });
        yield* controller.startSession(codexThreadId, { ...input, botName: "" });
        expect(mastra.createSession).toHaveBeenCalledOnce();
        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({ botConversation: true, botName: "" }),
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("queues Mastra follow-ups while the current turn is active", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;

        const first = yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "First message",
        });
        const second = yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Queued follow-up",
        });

        expect(second.turnId).not.toBe(first.turnId);
        expect(mastra.sendMessage).toHaveBeenCalledTimes(1);
        mastra.finishSend();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, { content: "Queued follow-up" });
        expect(
          events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
        ).toEqual([first.turnId, second.turnId]);
        expect(
          events
            .filter((event) => event.type === "session.state.changed")
            .map((event) => event.payload.state),
        ).toEqual(["running", "running"]);
        yield* Fiber.interrupt(eventsFiber);
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("rejects a queued Mastra turn when its provider is disabled", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: openCodeGoThreadId,
          engine: { provider: String(openCodeGoInstanceId), model: "gpt-5.6-luna" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(openCodeGoThreadId, {
          threadId: openCodeGoThreadId,
          provider: ProviderDriverKind.make("opencodeGo"),
          providerInstanceId: openCodeGoInstanceId,
          modelSelection: { instanceId: openCodeGoInstanceId, model: "gpt-5.6-luna" },
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({ threadId: openCodeGoThreadId, input: "First message" });
        const queued = yield* controller.sendTurn({
          threadId: openCodeGoThreadId,
          input: "Queued follow-up",
        });
        const failedTurn = yield* controller.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn.completed" &&
              event.turnId === queued.turnId &&
              event.payload.state === "failed",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;

        bridge.setInstanceEnabled(false);
        mastra.finishSend();
        const failure = yield* Fiber.join(failedTurn);

        assert.equal(failure._tag, "Some");
        expect(mastra.sendMessage).toHaveBeenCalledTimes(1);
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("serializes queued turns while dispatch admission is pending", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        bridge.blockNextDispatchAdmission();
        const firstFiber = yield* controller
          .sendTurn({ threadId: codexThreadId, input: "First message" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(bridge.waitForNextDispatchAdmission);

        const second = yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Queued while admission is pending",
        });
        expect(mastra.sendMessage).not.toHaveBeenCalled();

        const secondStarted = yield* controller.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.started" && event.turnId === second.turnId),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        bridge.releaseNextDispatchAdmission();
        yield* Fiber.join(firstFiber);
        expect(mastra.sendMessage).toHaveBeenCalledTimes(1);

        mastra.finishSend();
        const started = yield* Fiber.join(secondStarted);
        assert.equal(started._tag, "Some");
        expect(mastra.sendMessage).toHaveBeenCalledTimes(2);
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("does not revive a turn interrupted during dispatch admission", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );

        bridge.blockNextDispatchAdmission();
        const sendFiber = yield* controller
          .sendTurn({ threadId: codexThreadId, input: "Do not revive this turn" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(bridge.waitForNextDispatchAdmission);
        yield* controller.interruptTurn({ threadId: codexThreadId });
        bridge.setInstanceEnabled(false);
        bridge.releaseNextDispatchAdmission();

        const exit = yield* Fiber.await(sendFiber);
        assert.equal(Exit.isFailure(exit), true);
        yield* Effect.yieldNow;
        expect(mastra.sendMessage).not.toHaveBeenCalled();
        expect(events.some((event) => event.type === "turn.started")).toBe(false);
        yield* Fiber.interrupt(eventsFiber);
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("releases dispatch admission when the caller is interrupted", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        bridge.blockNextDispatchAdmission();
        const blocked = yield* controller
          .sendTurn({ threadId: codexThreadId, input: "Canceled before admission" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(bridge.waitForNextDispatchAdmission);
        yield* Fiber.interrupt(blocked);

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Next message" });
        expect(mastra.sendMessage).toHaveBeenCalledTimes(1);
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("ignores a stale Mastra send failure after the next turn starts", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;

        yield* controller.sendTurn({ threadId: codexThreadId, input: "First message" });
        const second = yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Queued follow-up",
        });
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        yield* Effect.yieldNow;
        expect(mastra.sendMessage).toHaveBeenCalledTimes(2);

        mastra.rejectSend(0, new Error("late failure"));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        expect(events.some((event) => event.type === "runtime.error")).toBe(false);
        expect(
          events.find((event) => event.type === "turn.started" && event.turnId === second.turnId),
        ).toBeDefined();
        yield* Fiber.interrupt(eventsFiber);
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("adds every Mastra step usage update", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Use two steps." });
        mastra.emit({
          type: "usage_update",
          usage: { promptTokens: 10, completionTokens: 4, reasoningTokens: 2, totalTokens: 14 },
        } as AgentControllerEvent);
        mastra.emit({
          type: "usage_update",
          usage: { promptTokens: 7, completionTokens: 3, reasoningTokens: 1, totalTokens: 10 },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        assert.deepEqual(
          events
            .filter((event) => event.type === "thread.token-usage.updated")
            .map((event) => event.payload.usage),
          [
            { usedTokens: 14, inputTokens: 10, outputTokens: 4, reasoningOutputTokens: 2 },
            { usedTokens: 24, inputTokens: 17, outputTokens: 7, reasoningOutputTokens: 3 },
          ],
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("publishes the final text when Mastra rewrites a message snapshot", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Say hello." });
        mastra.emit({
          type: "message_update",
          message: assistantMessage("Hello world"),
        } as AgentControllerEvent);
        mastra.emit({
          type: "message_end",
          message: assistantMessage("Hi there!"),
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastra.finishSend();

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(
          events
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta)
            .join(""),
          "Hi there!",
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("publishes a same-id rewrite after a tool boundary", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Check the project." });
        mastra.emit({
          type: "message_update",
          message: assistantMessage("draft", "same"),
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_start",
          toolCallId: "view-1",
          toolName: "view",
          args: { path: "package.json" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_end",
          toolCallId: "view-1",
          result: "{}",
          isError: false,
        } as AgentControllerEvent);
        mastra.emit({
          type: "message_end",
          message: assistantMessage("final revised", "same"),
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastra.finishSend();

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepEqual(
          events
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta),
          ["draft", "final revised"],
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("adds every Mastra step usage update", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Use two steps." });
        mastra.emit({
          type: "usage_update",
          usage: { promptTokens: 10, completionTokens: 4, reasoningTokens: 2, totalTokens: 14 },
        } as AgentControllerEvent);
        mastra.emit({
          type: "usage_update",
          usage: { promptTokens: 7, completionTokens: 3, reasoningTokens: 1, totalTokens: 10 },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        assert.deepEqual(
          events
            .filter((event) => event.type === "thread.token-usage.updated")
            .map((event) => event.payload.usage),
          [
            { usedTokens: 14, inputTokens: 10, outputTokens: 4, reasoningOutputTokens: 2 },
            { usedTokens: 24, inputTokens: 17, outputTokens: 7, reasoningOutputTokens: 3 },
          ],
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("reserves and settles billed observational-memory usage", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const usageLedger = makeUsageLedger();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const botId = BotId.make("bot-memory");
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Remember this.",
          botUsage: { botId, capLimit: 50_000 },
        });
        const options = mastra.harnessOptions[0]!;
        const callId = yield* Effect.promise(() =>
          options.startMemoryCall!({ threadId: codexThreadId, category: "observer" }),
        );
        assert.isDefined(callId);
        expect(usageLedger.reserve).toHaveBeenCalledWith(
          expect.objectContaining({
            reservationId: callId,
            botId,
            threadId: codexThreadId,
            category: "observer",
            maximumTokens: 32_000,
            capLimit: 50_000,
            provider: "codex",
            model: "gpt-5.6-sol",
          }),
        );

        yield* Effect.promise(() =>
          options.finishMemoryCall!({
            callId: callId!,
            category: "observer",
            usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
          }),
        );
        expect(usageLedger.settle).toHaveBeenCalledWith({
          reservationId: callId,
          state: "reported",
          inputTokens: 12,
          outputTokens: 5,
          reasoningTokens: null,
          settledAt: expect.any(String),
        });

        usageLedger.reserve.mockImplementationOnce(() =>
          Effect.fail(
            new BotUsageCapExceeded({
              botId,
              limit: 50_000,
              consumedTokens: 20_000,
              reservedTokens: 30_000,
              requestedTokens: 32_000,
            }),
          ),
        );
        yield* Effect.promise(() =>
          expect(
            options.startMemoryCall!({ threadId: codexThreadId, category: "reflector" }),
          ).rejects.toBeInstanceOf(BotUsageCapExceeded),
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      usageLedger.service,
    );
  });

  it.effect("keeps replies and status beats as separate completed messages", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Check the project." });
        mastra.emit({
          type: "message_update",
          message: assistantMessage("I'll check first.", "opening"),
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_start",
          toolCallId: "view-1",
          toolName: "view",
          args: { path: "package.json" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_end",
          toolCallId: "view-1",
          result: "{}",
          isError: false,
        } as AgentControllerEvent);
        mastra.emit({
          type: "message_end",
          message: assistantMessage("I found the configuration.", "status"),
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        assert.deepEqual(
          events.filter((event) => event.type === "item.completed").map((event) => event.itemId),
          [
            RuntimeItemId.make("mastra-answer-opening"),
            RuntimeItemId.make("view-1"),
            RuntimeItemId.make("mastra-answer-status"),
          ],
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("recreates a Mastra session after sendMessage fails", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const startInput = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access" as const,
        };
        yield* controller.startSession(codexThreadId, startInput);

        const failedTurn = yield* controller.streamEvents.pipe(
          Stream.filter(
            (event) => event.type === "turn.completed" && event.payload.state === "failed",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* controller.sendTurn({ threadId: codexThreadId, input: "First turn." });
        yield* Effect.yieldNow;
        mastra.failSend(new Error("Mastra session is poisoned"));
        yield* Fiber.join(failedTurn);
        yield* Effect.yieldNow;

        assert.deepEqual(yield* controller.listSessions(), []);
        expect(mastra.session.abort).toHaveBeenCalledOnce();
        expect(mastra.deleteSession).toHaveBeenCalledWith({
          resourceId: String(codexThreadId),
        });

        yield* controller.startSession(codexThreadId, startInput);
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Second turn." });

        expect(mastra.createSession).toHaveBeenCalledTimes(2);
        expect(mastra.sendMessage).toHaveBeenNthCalledWith(1, { content: "First turn." });
        expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, { content: "Second turn." });
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.sendTurn).not.toHaveBeenCalled();
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("keeps product feedback approval-gated in full-access mode", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        expect(mastra.session.state.set).toHaveBeenCalledWith(
          expect.objectContaining({ yolo: false }),
        );
        expect(mastra.session.permissions.setForTool).toHaveBeenCalledWith({
          toolName: AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
          policy: "ask",
        });
        expect(mastra.session.permissions.setForTool).not.toHaveBeenCalledWith({
          toolName: AKERU_CREATE_ROUTINE_TOOL_NAME,
          policy: expect.anything(),
        });
        expect(mastra.session.permissions.setForTool).toHaveBeenCalledWith({
          toolName: "RestartMcpServers",
          policy: "ask",
        });

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Prepare feedback." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "feedback-tool-1",
          toolName: AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
          args: { feedback: "The button failed." },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("feedback-tool-1"),
          decision: "acceptForSession",
        });

        expect(mastra.session.permissions.setForTool).not.toHaveBeenCalledWith({
          toolName: AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
          policy: "allow",
        });
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("records human handoff requests in the bot inbox", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-handoff-inbox-"));
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const sessionInput = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          botSandboxBrowserSharing: "shared" as const,
          runtimeMode: "full-access" as const,
        };
        yield* controller.startSession(codexThreadId, {
          ...sessionInput,
          botId: BotId.make("bot-one"),
          botName: "Research bot",
        });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "request_box_help",
            toolCallId: "tool-help",
            input: { reason: "captcha", message: "Complete the CAPTCHA." },
            approvalMode: "require-grant",
          }),
        );

        expect(
          BotInboxService.forSecretsDir(NodePath.join(baseDir, "userdata", "secrets")).list(),
        ).toMatchObject([
          {
            botId: "bot-one",
            botName: "Research bot",
            taskOrRoutine: "request_box_help",
            lastFailure: "Complete the CAPTCHA.",
          },
        ]);
        yield* controller.startSession(codexThreadId, sessionInput);
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).not.toContain(
          "request_box_help",
        );
        yield* Effect.promise(() =>
          expect(
            runtime.execute({
              threadId: String(codexThreadId),
              toolId: "request_box_help",
              toolCallId: "stale-handoff",
              input: { reason: "captcha", message: "Complete the CAPTCHA." },
              approvalMode: "require-grant",
            }),
          ).rejects.toThrow("Tool 'request_box_help' is not available for this turn."),
        );
      }),
      bridge.service,
      mastra.factory,
      undefined,
      baseDir,
    ).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
    );
  });

  it.effect("keeps a pending approval across reconnect and grants one exact tool call", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Run pwd." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shell-tool-1",
          toolName: "Shell",
          args: { command: "pwd" },
        } as AgentControllerEvent);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("shell-tool-1"),
          decision: "acceptAlways",
        });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        const execution = {
          threadId: String(codexThreadId),
          toolId: "Shell" as const,
          toolCallId: "shell-tool-1",
          input: { command: "pwd" },
          approvalMode: "require-grant" as const,
        };
        const receiptsFiber = yield* controller.streamEvents.pipe(
          Stream.filter((event) => event.type === "tool.receipt"),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* Effect.promise(() => runtime.execute(execution));
        const receipts = yield* Fiber.join(receiptsFiber);
        assert.deepEqual(
          [...receipts].map((event) => event.payload.phase),
          ["start", "success"],
        );
        assert.isTrue([...receipts].every((event) => event.payload.fatalToThread === false));
        yield* Effect.promise(() =>
          expect(runtime.execute(execution)).rejects.toThrow("Tool 'Shell' requires approval."),
        );
        expect(mastra.session.permissions.setForTool).not.toHaveBeenCalledWith({
          toolName: "Shell",
          policy: "allow",
        });
        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "shell-tool-1",
          decision: "approve",
        });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "send-tool-1",
          toolName: "gmail_send_message",
          args: { to: "user@example.com" },
        } as AgentControllerEvent);
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("send-tool-1"),
          decision: "decline",
        });
        const duplicateResponseError = yield* controller
          .respondToRequest({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make("send-tool-1"),
            decision: "accept",
          })
          .pipe(Effect.flip);
        expect(duplicateResponseError.message).toContain("no longer active");
        expect(mastra.session.respondToToolApproval).toHaveBeenCalledTimes(2);
        expect(mastra.session.respondToToolApproval).toHaveBeenLastCalledWith({
          toolCallId: "send-tool-1",
          decision: "decline",
        });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shell-tool-stale",
          toolName: "Shell",
          args: { command: "pwd" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_end",
          toolCallId: "shell-tool-stale",
          result: "cancelled",
          isError: true,
        } as AgentControllerEvent);
        const staleResponseError = yield* controller
          .respondToRequest({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make("shell-tool-stale"),
            decision: "accept",
          })
          .pipe(Effect.flip);
        expect(staleResponseError.message).toContain("no longer active");
        expect(mastra.session.respondToToolApproval).not.toHaveBeenCalledWith({
          toolCallId: "shell-tool-stale",
          decision: "approve",
        });
        yield* controller.interruptTurn({ threadId: codexThreadId });
        yield* Effect.promise(() =>
          expect(runtime.execute({ ...execution, toolCallId: "shell-tool-stale" })).rejects.toThrow(
            "Tool 'Shell' requires approval.",
          ),
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("fails closed for MCP tools missing from the manager index", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const mcpManager = {
      init: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({
        indexed_read: { mcp: { annotations: { readOnlyHint: true } } },
        ask_user: { mcp: { annotations: {} } },
      })),
      getServerStatuses: vi.fn(() => []),
    };
    const makeMcpManager: NonNullable<AgentControllerLiveOptions["makeMcpManager"]> = vi.fn(
      () => mcpManager as never,
    );
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          mcpServers: [
            {
              id: McpServerId.make("mcp-test"),
              name: "Test MCP",
              transport: "url",
              url: "https://example.com/mcp",
              enabled: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        });

        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Use tools." });
        for (const [toolCallId, toolName, args] of [
          ["builtin-safe", "execute_command", { command: "bun test" }],
          ["indexed-read", "indexed_read", { query: "status" }],
          ["connector-name-collision", "ask_user", { prompt: "Run connector action" }],
          ["missing-index", "new_mcp_tool", { value: "unknown" }],
        ] as const) {
          mastra.emit({
            type: "tool_approval_required",
            toolCallId,
            toolName,
            args,
          } as AgentControllerEvent);
        }
        yield* Effect.yieldNow;

        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "builtin-safe",
          decision: "approve",
        });
        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "indexed-read",
          decision: "approve",
        });
        expect(events.filter((event) => event.type === "request.opened")).toEqual([
          expect.objectContaining({
            requestId: "connector-name-collision",
            payload: expect.objectContaining({ target: "ask_user" }),
          }),
          expect.objectContaining({
            requestId: "missing-index",
            payload: expect.objectContaining({ target: "new_mcp_tool" }),
          }),
        ]);
        yield* Fiber.interrupt(eventsFiber);
      }),
      bridge.service,
      mastra.factory,
      makeMcpManager,
    );
  });

  it.effect("resolves pending approvals when a turn or session ends", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Finish." });
        for (const requestId of ["finish-1", "finish-2"]) {
          mastra.emit({
            type: "tool_approval_required",
            toolCallId: requestId,
            toolName: "gmail_send_message",
            args: { to: "person@example.com" },
          } as AgentControllerEvent);
        }
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Interrupt." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "interrupt-1",
          toolName: "gmail_send_message",
          args: { to: "person@example.com" },
        } as AgentControllerEvent);
        yield* controller.interruptTurn({ threadId: codexThreadId });
        yield* Effect.yieldNow;

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Stop." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "stop-1",
          toolName: "gmail_send_message",
          args: { to: "person@example.com" },
        } as AgentControllerEvent);
        yield* controller.stopSession({ threadId: codexThreadId });
        yield* Effect.yieldNow;

        const resolved = events.filter((event) => event.type === "request.resolved");
        expect(resolved.map((event) => event.requestId)).toEqual([
          "finish-1",
          "finish-2",
          "interrupt-1",
          "stop-1",
        ]);
        for (const event of resolved) {
          expect(event.payload).toMatchObject({
            decision: "cancel",
            actor: "system",
            outcome: "cancelled",
          });
        }
        yield* Fiber.interrupt(eventsFiber);
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("approves question tools without showing an approval request", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const events: ProviderRuntimeEvent[] = [];
        const collector = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Ask me a question." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "question-1",
          toolName: "ask_user",
          args: {
            question: "Pick one.",
            options: [{ label: "First", description: "Choose the first option" }],
          },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;

        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "question-1",
          decision: "approve",
        });
        expect(events.some((event) => event.type === "request.opened")).toBe(false);

        mastra.emit({
          type: "tool_suspended",
          toolCallId: "question-1",
          toolName: "ask_user",
          args: {},
          suspendPayload: {
            question: "Pick one.",
            options: [{ label: "First", description: "Choose the first option" }],
            selectionMode: "single_select",
          },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;

        expect(events).toContainEqual(
          expect.objectContaining({
            type: "user-input.requested",
            requestId: "question-1",
            payload: expect.objectContaining({
              questions: [
                expect.objectContaining({
                  question: "Pick one.",
                  options: [{ label: "First", description: "Choose the first option" }],
                }),
              ],
            }),
          }),
        );
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("auto review allows safe commands and asks before destructive commands", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const events: ProviderRuntimeEvent[] = [];
        const collector = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "auto",
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Inspect, then clean up." });

        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "read-safe",
          toolName: "execute_command",
          args: { command: "pwd" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "delete-risky",
          toolName: "execute_command",
          args: { command: "rm -rf ./temporary-output" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shred-risky",
          toolName: "execute_command",
          args: { command: "shred important-file" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "wrapped-shred-risky",
          toolName: "execute_command",
          args: { command: 'bash -c "shred -u important-file"' },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "command-shred-risky",
          toolName: "execute_command",
          args: { command: "command shred -u important-file" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "xargs-shred-risky",
          toolName: "execute_command",
          args: { command: "printf '%s\\n' important-file | xargs shred -u" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "xargs-rm-risky",
          toolName: "execute_command",
          args: { command: "printf '%s\\n' important-file | xargs rm -f" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "xargs-env-rm-risky",
          toolName: "execute_command",
          args: { command: "printf '%s\\n' important-file | xargs env rm -f" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "xargs-shell-rm-risky",
          toolName: "execute_command",
          args: { command: "printf '%s\\n' important-file | xargs sh -c 'rm -f \"$1\"' _" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "find-shred-risky",
          toolName: "execute_command",
          args: { command: "find . -name important-file -exec shred -u {} \\;" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "find-env-rm-risky",
          toolName: "execute_command",
          args: { command: "find . -name important-file -exec env rm -f {} \\;" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "dd-risky",
          toolName: "execute_command",
          args: { command: "dd if=/dev/zero of=important-file" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "redirected-dd-risky",
          toolName: "execute_command",
          args: { command: "dd if=/dev/zero > important-file" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "plain-move-risky",
          toolName: "execute_command",
          args: { command: "mv replacement important-file" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "forced-move-risky",
          toolName: "execute_command",
          args: { command: "mv -f replacement important-file" },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;

        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "read-safe",
          decision: "approve",
        });
        for (const requestId of [
          "delete-risky",
          "shred-risky",
          "wrapped-shred-risky",
          "command-shred-risky",
          "xargs-shred-risky",
          "xargs-rm-risky",
          "xargs-env-rm-risky",
          "xargs-shell-rm-risky",
          "find-shred-risky",
          "find-env-rm-risky",
          "dd-risky",
          "redirected-dd-risky",
          "plain-move-risky",
          "forced-move-risky",
        ]) {
          expect(mastra.session.respondToToolApproval).not.toHaveBeenCalledWith({
            toolCallId: requestId,
            decision: "approve",
          });
          expect(events).toContainEqual(
            expect.objectContaining({ type: "request.opened", requestId }),
          );
        }
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("keeps a suspended Mastra turn active until tool input resumes", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Ask for input." });
        mastra.emit({
          type: "tool_suspended",
          toolCallId: "tool-input-1",
          toolName: "ask_user",
          args: {},
          suspendPayload: {},
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "suspended" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;

        const [waiting] = yield* controller.listSessions();
        assert.isDefined(waiting?.activeTurnId);

        yield* controller.respondToUserInput({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("tool-input-1"),
          answers: { "tool-input-1": "Continue" },
        });
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);

        const [completed] = yield* controller.listSessions();
        assert.isUndefined(completed?.activeTurnId);
        expect(mastra.session.respondToToolSuspension).toHaveBeenCalledWith({
          toolCallId: "tool-input-1",
          resumeData: "Continue",
        });
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("fails a cancelled Mastra suspension and accepts the next turn", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const events: ProviderRuntimeEvent[] = [];
        const collector = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Ask for input." });
        mastra.emit({
          type: "tool_suspended",
          toolCallId: "tool-input-cancelled",
          toolName: "ask_user",
          args: {},
          suspendPayload: {},
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "suspended" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;

        vi.mocked(mastra.session.respondToToolSuspension).mockImplementationOnce(async () => {
          mastra.emit({
            type: "tool_suspension_cancelled",
            toolCallId: "tool-input-cancelled",
            toolName: "ask_user",
            reason: "sendStreamResume() could not find a suspended run",
          } as AgentControllerEvent);
          mastra.emit({
            type: "error",
            error: new Error("AGENT_SEND_STREAM_RESUME_NO_SUSPENDED_THREAD_RUN"),
          } as AgentControllerEvent);
          mastra.emit({ type: "agent_end", reason: "error" } as AgentControllerEvent);
        });
        const responseExit = yield* controller
          .respondToUserInput({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make("tool-input-cancelled"),
            answers: { "tool-input-cancelled": "Continue" },
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(responseExit));
        yield* Effect.yieldNow;

        const failedTurns = events.filter(
          (event) => event.type === "turn.completed" && event.payload.state === "failed",
        );
        expect(failedTurns).toHaveLength(1);
        expect(failedTurns[0]).toMatchObject({
          payload: {
            errorMessage: "This response could not resume. Send your reply again.",
          },
        });
        expect(
          events.filter(
            (event) =>
              event.type === "user-input.resolved" &&
              String(event.requestId) === "tool-input-cancelled",
          ),
        ).toHaveLength(0);
        expect(mastra.deleteSession).not.toHaveBeenCalled();

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Try again." });
        expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, { content: "Try again." });
        expect(mastra.createSession).toHaveBeenCalledTimes(1);
        mastra.finishSend();
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("reads persisted image attachments for Mastra turns", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-mastra-image-"));
    const attachmentsDir = NodePath.join(baseDir, "userdata", "attachments");
    NodeFS.mkdirSync(attachmentsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, "image-1.png"), "image");

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Inspect this image.",
          attachments: [
            {
              type: "image",
              id: "image-1",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        });

        expect(mastra.sendMessage).toHaveBeenCalledWith({
          content: `Inspect this image.\n\n[Attached image "screenshot.png" is saved at: ${NodePath.join(attachmentsDir, "image-1.png")}]`,
          files: [
            {
              data: "aW1hZ2U=",
              mediaType: "image/png",
              filename: "screenshot.png",
            },
          ],
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
        ),
      ),
      bridge.service,
      mastra.factory,
      undefined,
      baseDir,
    );
  });

  it.effect("attaches the globally installed MCP servers selected for the bot", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-mastra-mcp-"));
    const mcpManager = {
      init: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({ "builtin-exa_search": {}, "t3-code_preview_status": {} })),
      getServerStatuses: vi.fn(() => [{ name: "builtin-exa", connected: true }]),
    };
    const makeMcpManagerMock = vi.fn((_dataDir, _configDir, _servers) => mcpManager as never);
    const makeMcpManager: NonNullable<AgentControllerLiveOptions["makeMcpManager"]> =
      makeMcpManagerMock;
    const exaServer = {
      id: McpServerId.make("builtin-exa"),
      name: "Exa",
      transport: "url" as const,
      url: "https://mcp.exa.ai/mcp",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const session = yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          mcpServers: [exaServer],
        });

        assert.deepEqual(session.mcpServerIds, [exaServer.id]);
        expect(makeMcpManagerMock).toHaveBeenCalledOnce();
        expect(makeMcpManagerMock.mock.calls[0]?.[2]).toEqual({
          "builtin-exa": { url: "https://mcp.exa.ai/mcp" },
          "t3-code": {
            url: "http://127.0.0.1:15070/mcp",
            headers: { Authorization: "Bearer preview-test" },
          },
        });
        expect(mcpManager.init).toHaveBeenCalledOnce();
        assert.property(
          mastra.harnessOptions[0]?.getThreadTools(String(codexThreadId)),
          "builtin-exa_search",
        );
        assert.property(
          mastra.harnessOptions[0]?.getThreadTools(String(codexThreadId)),
          "preview_status",
        );
        expect(mastra.session.permissions.setForTool).toHaveBeenCalledWith({
          toolName: "builtin-exa_search",
          policy: "ask",
        });

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Search." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "exa-tool-1",
          toolName: "builtin-exa_search",
          args: { operation: "read" },
        } as AgentControllerEvent);
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("exa-tool-1"),
          decision: "acceptForSession",
        });
        const syncApproval = mastra.harnessOptions[0]?.syncThreadToolApproval;
        assert.isDefined(syncApproval);
        yield* Effect.promise(() =>
          syncApproval(String(codexThreadId), "builtin-exa_search", true),
        );
        expect(mastra.session.permissions.setForTool).toHaveBeenLastCalledWith({
          toolName: "builtin-exa_search",
          policy: "ask",
        });
        yield* Effect.promise(() =>
          syncApproval(String(codexThreadId), "builtin-exa_search", false),
        );
        expect(mastra.session.permissions.setForTool).toHaveBeenLastCalledWith({
          toolName: "builtin-exa_search",
          policy: "allow",
        });
        mastra.emit({
          type: "tool_end",
          toolCallId: "exa-tool-1",
          result: "failed",
          isError: true,
          denied: false,
        } as AgentControllerEvent);
        expect(
          SubscriptionAuthService.forSecretsDir(
            NodePath.join(baseDir, "userdata", "secrets"),
          ).mcpRequestHealth(exaServer.id)?.health,
        ).toBe("failed-first-request");

        mastra.emit({
          type: "tool_start",
          toolCallId: "exa-tool-2",
          toolName: "builtin-exa_search",
          args: { operation: "read" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_end",
          toolCallId: "exa-tool-2",
          result: "ok",
          isError: false,
          denied: false,
        } as AgentControllerEvent);
        expect(
          SubscriptionAuthService.forSecretsDir(
            NodePath.join(baseDir, "userdata", "secrets"),
          ).mcpRequestHealth(exaServer.id)?.health,
        ).toBe("recovered");
        mastra.finishSend();

        yield* controller.stopSession({ threadId: codexThreadId });
        expect(mcpManager.disconnect).toHaveBeenCalledOnce();
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
        ),
      ),
      bridge.service,
      mastra.factory,
      makeMcpManager,
      baseDir,
      undefined,
      {
        issueMcpCredential: ({ threadId, providerInstanceId }) =>
          Effect.succeed({
            config: {
              environmentId: EnvironmentId.make("environment-preview-test"),
              threadId,
              providerSessionId: "provider-session-preview-test",
              providerInstanceId,
              endpoint: "http://127.0.0.1:15070/mcp",
              authorizationHeader: "Bearer preview-test",
            },
          }),
        revokeMcpCredential: () => Effect.void,
      },
    );
  });

  it.effect("keeps Computer Use approval data and desktop content out of runtime events", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const toolName = computerUseToolName;
    const mcpManager = computerUseMcpManager();
    const server = computerUseServer();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          mcpServers: [server],
        });

        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Control this Mac." });
        mastra.emit({
          type: "tool_start",
          toolCallId: "computer-use-1",
          toolName,
          args: { text: "typed secret", app: "Private App", path: "/private/tester" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_update",
          toolCallId: "computer-use-1",
          partialResult: { windowTitle: "Private Window" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "computer-use-1",
          toolName,
          args: { text: "typed secret", app: "Private App" },
        } as AgentControllerEvent);
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("computer-use-1"),
          decision: "acceptForSession",
        });
        mastra.emit({
          type: "tool_end",
          toolCallId: "computer-use-1",
          result: { screenshot: "raw frame", applicationContent: "private content" },
        } as AgentControllerEvent);
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "computer-use-2",
          toolName,
          args: { text: "deny this" },
        } as AgentControllerEvent);
        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("computer-use-2"),
          decision: "decline",
        });
        mastra.emit({
          type: "error",
          error: new Error("Private Window at /private/tester failed"),
        } as AgentControllerEvent);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain("typed secret");
        expect(serialized).not.toContain("Private App");
        expect(serialized).not.toContain("Private Window");
        expect(serialized).not.toContain("private/tester");
        expect(serialized).not.toContain("raw frame");
        expect(serialized).not.toContain("private content");
        const approval = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { readonly type: "request.opened" }> =>
            event.type === "request.opened" && event.requestId === "computer-use-1",
        );
        assert.isDefined(approval);
        assert.isDefined(approval.payload.options);
        expect(approval.payload.options.map((option) => option.decision)).toEqual([
          "accept",
          "decline",
        ]);
        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "computer-use-1",
          decision: "approve",
        });
        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "computer-use-2",
          decision: "decline",
        });
        expect(mastra.session.permissions.setForTool).not.toHaveBeenCalledWith({
          toolName,
          policy: "allow",
        });
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
      (() => mcpManager as never) as NonNullable<AgentControllerLiveOptions["makeMcpManager"]>,
      undefined,
      undefined,
      {
        resolveComputerUseServer: async () => ({
          command: "/local/launcher",
          args: ["mcp"],
          env: {},
        }),
      },
    );
  });

  it.effect("releases Computer Use when session setup and deletion fail", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const mcpManager = computerUseMcpManager();
    const nextThreadId = ThreadId.make("thread-mastra-codex-next");
    vi.mocked(mastra.session.state.set).mockRejectedValueOnce(new Error("setup failed"));

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller
          .startSession(codexThreadId, {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            mcpServers: [computerUseServer()],
          })
          .pipe(Effect.ignore);

        yield* controller.resolveEngine({
          threadId: nextThreadId,
          engine: { provider: "codex", model: "gpt-5.6-sol" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(nextThreadId, {
          threadId: nextThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          mcpServers: [computerUseServer()],
        });

        mastra.deleteSession.mockRejectedValueOnce(new Error("delete failed"));
        yield* controller.stopSession({ threadId: nextThreadId }).pipe(Effect.ignore);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          mcpServers: [computerUseServer()],
        });
        expect(mcpManager.init).toHaveBeenCalledTimes(3);
      }),
      bridge.service,
      mastra.factory,
      (() => mcpManager as never) as NonNullable<AgentControllerLiveOptions["makeMcpManager"]>,
      undefined,
      undefined,
      {
        resolveComputerUseServer: async () => ({
          command: "/local/launcher",
          args: ["mcp"],
          env: {},
        }),
      },
    );
  });

  it.effect("enforces delegated MCP and memory grants for tools and prompt context", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-delegated-memory-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const readMemory = vi.spyOn(botMemoryStore, "readPromptSnapshot");
    const mcpManager = {
      init: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      getTools: vi.fn(() => ({ exa_search: {} })),
      getServerStatuses: vi.fn(() => [{ name: "web", connected: true }]),
    };
    const makeMcpManagerMock = vi.fn((_dataDir, _configDir, _servers) => mcpManager as never);
    const makeMcpManager: NonNullable<AgentControllerLiveOptions["makeMcpManager"]> =
      makeMcpManagerMock;
    const webId = McpServerId.make("web");
    const emailId = McpServerId.make("email");
    const access: AkeruDelegationAccessGrant = {
      allowedToolIds: ["Read", "ExternalRead", "CopyToBox", "CopyFromBox"],
      memoryScopes: [],
      sandbox: "local",
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [webId],
      disabledMcpServerIds: [emailId],
      approvalCeiling: "send",
    };
    const runtime = {
      send: vi.fn(async () => null),
      sendToUser: vi.fn(async () => {
        throw new Error("not used");
      }),
      parentFinished: vi.fn(async () => undefined),
      accessForThread: () => access,
    };
    const layer = makeLayer(
      bridge.service,
      mastra.factory,
      makeMcpManager,
      undefined,
      undefined,
      { botMemoryStore },
      runtime,
    );
    const server = (id: typeof webId, name: string) => ({
      id,
      name,
      transport: "url" as const,
      url: `https://${name}.example/mcp`,
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      const session = yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: process.cwd(),
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
        mcpServers: [server(webId, "web"), server(emailId, "email")],
        memoryAccess: {
          tenantId: AkeruMemoryTenantId.make("local"),
          userId: AkeruMemoryUserId.make("owner"),
          threadId: codexThreadId,
          projectId: ProjectId.make("delegation-memory"),
          workspaceRoot: process.cwd(),
          botId: BotId.make("delegated-bot"),
          respondingBotId: BotId.make("delegated-bot"),
          groupId: null,
          groupMemberBotIds: [],
        },
      });

      expect(session.mcpServerIds).toEqual([webId]);
      expect(makeMcpManagerMock.mock.calls[0]?.[2]).toEqual({
        web: { url: "https://web.example/mcp" },
      });
      const toolIds = mastra.harnessOptions[0]?.toolRuntime
        .toolsForThread(String(codexThreadId))
        .map((tool) => tool.id);
      expect(toolIds).not.toContain("ExternalRead");
      expect(toolIds).not.toContain("CopyToBox");
      expect(toolIds).not.toContain("CopyFromBox");
      expect(toolIds).not.toContain("memory");
      yield* controller.sendTurn({ threadId: codexThreadId, input: "Do the delegated task." });
      expect(mastra.session.sendMessage).toHaveBeenCalled();
      expect(readMemory).not.toHaveBeenCalled();
      expect(mastra.session.state.get()).not.toHaveProperty("persistentMemoryContext");
    }).pipe(
      Effect.provide(layer),
      Effect.orDie,
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
      ),
    );
  });

  it.effect("creates no workspace for a delegated sandbox denial", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const access: AkeruDelegationAccessGrant = {
      allowedToolIds: ["Shell", "Read"],
      memoryScopes: [],
      sandbox: null,
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "send",
    };
    const layer = makeLayer(
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        send: vi.fn(async () => null),
        sendToUser: vi.fn(async () => {
          throw new Error("not used");
        }),
        parentFinished: vi.fn(async () => undefined),
        accessForThread: () => access,
      },
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: process.cwd(),
        botId: BotId.make("delegated-child"),
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
      });

      expect(mastra.createSession.mock.calls[0]?.[0]).not.toHaveProperty("workspace");
      expect(mastra.harnessOptions[0]?.toolRuntime.toolsForThread(String(codexThreadId))).toEqual(
        [],
      );
    }).pipe(Effect.provide(layer), Effect.orDie);
  });

  it.effect("creates a credentialed remote workspace for a delegated sandbox grant", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const access: AkeruDelegationAccessGrant = {
      allowedToolIds: ["Shell", "Read"],
      memoryScopes: [],
      sandbox: "upstash",
      runtimeMode: "full-access",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "secrets",
    };
    const remote = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });
    const makeRemoteWorkspace = vi.fn(async () => remote);
    const makeBotBrowser = vi.fn(() => ({
      tools: {},
      attachment: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }));
    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace,
      makeBotBrowser: makeBotBrowser as never,
      delegationRuntime: {
        send: vi.fn(async () => null),
        sendToUser: vi.fn(async () => {
          throw new Error("not used");
        }),
        parentFinished: vi.fn(async () => undefined),
        accessForThread: () => access,
      },
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, makeUsageLedger().service),
          ServerConfig.layerTest(process.cwd(), {
            prefix: "akeru-mastra-remote-sandbox-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        modelSelection: codexSelection,
        runtimeMode: "full-access",
        botSandbox: "upstash",
        botSandboxEnvironment: {
          UPSTASH_REDIS_REST_URL: "https://sandbox.example",
          UPSTASH_REDIS_REST_TOKEN: "sandbox-token",
        },
      });

      expect(makeRemoteWorkspace).toHaveBeenCalledOnce();
      expect(makeRemoteWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: `thread-${codexThreadId}`,
          sandbox: "upstash",
          environment: {
            UPSTASH_REDIS_REST_URL: "https://sandbox.example",
            UPSTASH_REDIS_REST_TOKEN: "sandbox-token",
          },
          workspaceId: expect.stringMatching(/^akeru-[a-f0-9]{24}$/),
          identityFile: expect.stringMatching(/provider\.json$/),
        }),
      );
      expect(mastra.createSession.mock.calls[0]?.[0]).toMatchObject({ workspace: remote });
      expect(makeBotBrowser).toHaveBeenCalledOnce();
      yield* controller.stopSession({ threadId: codexThreadId });
    }).pipe(Effect.provide(layer), Effect.orDie);
  });

  it.effect("destroys obsolete and stops final pooled remote workspaces", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const firstWorkspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });
    const secondWorkspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });
    const firstDestroy = vi.spyOn(firstWorkspace, "destroy");
    const secondStop = vi.spyOn(secondWorkspace, "stop");
    const secondDestroy = vi.spyOn(secondWorkspace, "destroy");
    const makeRemoteWorkspace = vi
      .fn()
      .mockResolvedValueOnce(firstWorkspace)
      .mockResolvedValueOnce(secondWorkspace);
    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, makeUsageLedger().service),
          ServerConfig.layerTest(process.cwd(), {
            prefix: "akeru-mastra-resource-finalizer-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const input = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access" as const,
          botId: "bot-one" as never,
          botSandboxBrowserSharing: "separate" as const,
        };
        yield* controller.startSession(codexThreadId, { ...input, botSandbox: "upstash" });
        yield* controller.startSession(codexThreadId, { ...input, botSandbox: "vercel" });
        expect(firstDestroy).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(layer), Effect.orDie);

      expect(secondStop).toHaveBeenCalledOnce();
      expect(secondDestroy).not.toHaveBeenCalled();
    });
  });

  it.effect("waits for observational memory shutdown before closing the controller scope", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const destroyStarted = Promise.withResolvers<void>();
    const destroyReleased = Promise.withResolvers<void>();
    const factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]> = async (
      options,
    ) => {
      const harness = await mastra.factory(options);
      return {
        ...harness,
        destroy: async () => {
          destroyStarted.resolve();
          await destroyReleased.promise;
        },
      };
    };

    return Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      yield* Layer.buildWithScope(makeLayer(bridge.service, factory), scope);
      let scopeClosed = false;
      const closeScope = yield* Scope.close(scope, Exit.void).pipe(
        Effect.tap(() => Effect.sync(() => (scopeClosed = true))),
        Effect.forkScoped,
      );

      yield* Effect.promise(() => destroyStarted.promise);
      yield* Effect.yieldNow;
      expect(scopeClosed).toBe(false);

      destroyReleased.resolve();
      yield* Fiber.join(closeScope);
      expect(scopeClosed).toBe(true);
    });
  });

  it.effect("keeps the same remote workspace when only cwd changes", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const remote = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });
    const destroy = vi.spyOn(remote, "destroy");
    const makeRemoteWorkspace = vi.fn(async () => remote);
    const makeBotBrowser = vi.fn(() => ({
      tools: {},
      attachment: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }));
    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace,
      makeBotBrowser: makeBotBrowser as never,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, makeUsageLedger().service),
          ServerConfig.layerTest(process.cwd(), {
            prefix: "akeru-mastra-same-workspace-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
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
        botSandbox: "upstash" as const,
      };
      yield* controller.startSession(codexThreadId, { ...input, cwd: process.cwd() });
      yield* controller.startSession(codexThreadId, { ...input, cwd: NodeOS.tmpdir() });

      expect(makeRemoteWorkspace).toHaveBeenCalledOnce();
      expect(destroy).not.toHaveBeenCalled();
      expect(makeBotBrowser).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer), Effect.orDie);
  });

  it.effect("runs Claude through the Akeru Mastra harness", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "claudeAgent", model: "claude-fable-5" },
          fallback: codexSelection,
          mode: "plan",
          botConversation: true,
        });
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const result = yield* controller.sendTurn({
          threadId: claudeThreadId,
          input: "Use Claude.",
        });

        expect(String(result.turnId)).toMatch(/^mastra-turn-/);
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.sendTurn).not.toHaveBeenCalled();
        expect(mastra.createSession).toHaveBeenCalledOnce();
        expect(mastra.session.model.switch).toHaveBeenCalledWith({
          modelId: "anthropic/claude-fable-5",
        });
        expect(mastra.sendMessage).toHaveBeenCalledOnce();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("runs Grok through the Akeru Mastra harness", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: grokThreadId,
          engine: { provider: "grok", model: "grok-code-fast-1" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(grokThreadId, {
          threadId: grokThreadId,
          provider: ProviderDriverKind.make("grok"),
          providerInstanceId: grokInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const result = yield* controller.sendTurn({
          threadId: grokThreadId,
          input: "Use Grok.",
        });

        expect(String(result.turnId)).toMatch(/^mastra-turn-/);
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.sendTurn).not.toHaveBeenCalled();
        expect(mastra.createSession).toHaveBeenCalledOnce();
        expect(mastra.session.model.switch).toHaveBeenCalledWith({
          modelId: "xai/grok-code-fast-1",
        });
        expect(mastra.sendMessage).toHaveBeenCalledOnce();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("adds compact personality instructions to legacy bot turns", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const threadId = ThreadId.make("thread-legacy-personality");
        const instanceId = ProviderInstanceId.make("legacyCustom");
        const selection = { instanceId, model: "legacy-model" };
        yield* controller.resolveEngine({
          threadId,
          engine: null,
          fallback: selection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("legacyCustom"),
          providerInstanceId: instanceId,
          modelSelection: selection,
          runtimeMode: "full-access",
          botId: BotId.make("bot-grok"),
          botName: "Mina",
          personalityTone: 20,
        });
        yield* controller.resolveEngine({
          threadId,
          engine: null,
          fallback: selection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.sendTurn({ threadId, input: "hey what's up" });

        expect(bridge.sendTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.stringContaining("20/100, a 80% chill and 20% professional blend"),
          }),
        );
        expect(bridge.sendTurn.mock.calls[0]?.[0].input).toContain("hey what's up");
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect.each([0, 1, 2])(
    "settles a legacy foreground review only after one successful memory call (count: %s)",
    (successfulMemoryCalls) => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const credentials = makeMemoryOnlyCredentialOptions();
      const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-review-cadence-"));
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-legacy-review");
      const groupId = GroupId.make("group-legacy-review");
      const memoryAccess = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: claudeThreadId,
        projectId: ProjectId.make("project-legacy-review"),
        workspaceRoot: "/workspace/legacy-review",
        botId,
        groupId,
        respondingBotId: botId,
        groupMemberBotIds: [botId],
      } as const;
      const completedEvent: ProviderRuntimeEvent = {
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: openCodeInstanceId,
        threadId: claudeThreadId,
        turnId: TurnId.make("legacy-turn"),
        type: "turn.completed",
        eventId: EventId.make("legacy-review-complete"),
        createdAt: "2026-09-14T12:00:00.000Z",
        payload: { state: "completed", stopReason: null },
      };
      bridge.sendTurn.mockImplementation((input) =>
        completeLegacyTurnWithMemoryReview(
          input,
          TurnId.make("legacy-turn"),
          successfulMemoryCalls,
        ),
      );
      const service = { ...bridge.service, streamEvents: Stream.succeed(completedEvent) };

      return provideController(
        Effect.gen(function* () {
          for (let prompt = 1; prompt <= 10; prompt += 1) {
            const reservation = yield* Effect.promise(() =>
              botMemoryStore.reserveReviewCadence(botId, {
                threadId: `group-history-${prompt}`,
                groupId: String(groupId),
                text: `Group prompt ${prompt}`,
              }),
            );
            yield* Effect.promise(() => botMemoryStore.settleReviewCadence(reservation, true));
          }
          const controller = yield* AgentController;
          yield* controller.resolveEngine({
            threadId: claudeThreadId,
            engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(claudeThreadId, {
            threadId: claudeThreadId,
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            botId,
            botName: "OpenCode Review Bot",
            memoryAccess,
          });
          McpMemoryToolSession.setMcpMemoryToolSession(
            claudeThreadId,
            createBotMemoryToolHandler(botMemoryStore, memoryAccess, new Set(["user", "group"]))
              .memory,
          );

          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Threshold prompt" });
          const context = bridge.sendTurn.mock.calls[0]?.[0].persistentMemoryContext;
          expect(context).toContain("<automatic-memory-review>");
          expect(context).toContain("only your GROUP.md for this active group");
          expect(context).toContain("Never read or change another bot's group memory");
          assert.equal(
            (yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId, String(groupId))))
              .acceptedPromptCount,
            10,
          );

          yield* controller.streamEvents.pipe(Stream.take(1), Stream.runDrain);
          assert.deepEqual(
            yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId, String(groupId))),
            {
              acceptedPromptCount: 11,
              reviewedThroughPromptCount: successfulMemoryCalls === 1 ? 10 : 0,
              dueOnNextAcceptedPrompt: successfulMemoryCalls !== 1,
            },
          );
        }),
        service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore, ...credentials },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect.each(["failed", "interrupted", "cancelled", "aborted"] as const)(
    "keeps a legacy review due after terminal %s",
    (terminalState) => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-review-failed-"));
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make(`bot-legacy-${terminalState}`);
      const memoryAccess = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: claudeThreadId,
        projectId: ProjectId.make("project-legacy-failure"),
        workspaceRoot: "/workspace/legacy-failure",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      } as const;
      const event: ProviderRuntimeEvent =
        terminalState === "aborted"
          ? {
              provider: ProviderDriverKind.make("opencode"),
              providerInstanceId: openCodeInstanceId,
              threadId: claudeThreadId,
              turnId: TurnId.make("legacy-turn"),
              type: "turn.aborted",
              eventId: EventId.make("legacy-review-aborted"),
              createdAt: "2026-09-14T12:00:00.000Z",
              payload: { reason: "Provider aborted the turn." },
            }
          : {
              provider: ProviderDriverKind.make("opencode"),
              providerInstanceId: openCodeInstanceId,
              threadId: claudeThreadId,
              turnId: TurnId.make("legacy-turn"),
              type: "turn.completed",
              eventId: EventId.make(`legacy-review-${terminalState}`),
              createdAt: "2026-09-14T12:00:00.000Z",
              payload: { state: terminalState, stopReason: null },
            };
      const service = { ...bridge.service, streamEvents: Stream.succeed(event) };

      return provideController(
        Effect.gen(function* () {
          for (let prompt = 1; prompt <= 10; prompt += 1) {
            const reservation = yield* Effect.promise(() =>
              botMemoryStore.reserveReviewCadence(botId),
            );
            yield* Effect.promise(() => botMemoryStore.settleReviewCadence(reservation, true));
          }
          const controller = yield* AgentController;
          yield* controller.resolveEngine({
            threadId: claudeThreadId,
            engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(claudeThreadId, {
            threadId: claudeThreadId,
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            memoryAccess,
          });
          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Threshold prompt" });
          yield* controller.streamEvents.pipe(Stream.take(1), Stream.runDrain);

          assert.deepEqual(yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId)), {
            acceptedPromptCount: 10,
            reviewedThroughPromptCount: 0,
            dueOnNextAcceptedPrompt: true,
          });
        }),
        service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect("settles both same-thread legacy prompts admitted before either terminal", () =>
    Effect.gen(function* () {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const nativeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const service = { ...bridge.service, streamEvents: Stream.fromPubSub(nativeEvents) };
      const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-late-terminal-"));
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-late-terminal");
      const turnA = TurnId.make("legacy-turn-a");
      const secondDispatchEntered = yield* Deferred.make<void>();
      const releaseSecondDispatch = yield* Deferred.make<void>();
      bridge.sendTurn
        .mockImplementationOnce((input) =>
          Effect.succeed({ threadId: input.threadId, turnId: turnA }),
        )
        .mockImplementationOnce((input) =>
          Deferred.succeed(secondDispatchEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSecondDispatch)),
            Effect.as({ threadId: input.threadId, turnId: turnA }),
          ),
        );
      const terminal = (turnId: TurnId, eventId: string): ProviderRuntimeEvent => ({
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: openCodeInstanceId,
        threadId: claudeThreadId,
        turnId,
        type: "turn.completed",
        eventId: EventId.make(eventId),
        createdAt: "2026-09-14T12:00:00.000Z",
        payload: { state: "completed", stopReason: null },
      });

      yield* provideController(
        Effect.gen(function* () {
          for (let prompt = 1; prompt <= 10; prompt += 1) {
            const reservation = yield* Effect.promise(() =>
              botMemoryStore.reserveReviewCadence(botId),
            );
            yield* Effect.promise(() => botMemoryStore.settleReviewCadence(reservation, true));
          }
          const controller = yield* AgentController;
          yield* controller.resolveEngine({
            threadId: claudeThreadId,
            engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(claudeThreadId, {
            threadId: claudeThreadId,
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            runtimeMode: "approval-required",
            memoryAccess: {
              tenantId: AkeruMemoryTenantId.make("local"),
              userId: AkeruMemoryUserId.make("owner"),
              threadId: claudeThreadId,
              projectId: ProjectId.make("project-late-terminal"),
              workspaceRoot: "/workspace/late-terminal",
              botId,
              groupId: null,
              respondingBotId: botId,
              groupMemberBotIds: [],
            },
          });
          const terminalObserved = yield* Deferred.make<void>();
          let observedCount = 0;
          const streamFiber = yield* Stream.runForEach(controller.streamEvents, () => {
            observedCount += 1;
            return Effect.all([
              observedCount === 2
                ? Deferred.succeed(terminalObserved, undefined).pipe(Effect.ignore)
                : Effect.void,
            ]).pipe(Effect.asVoid);
          }).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;

          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Turn A" });
          const secondSend = yield* controller
            .sendTurn({ threadId: claudeThreadId, input: "Turn B" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(secondDispatchEntered);
          const lateObserved = yield* Deferred.make<void>();
          const lateFiber = yield* controller.streamEvents.pipe(
            Stream.take(1),
            Stream.runDrain,
            Effect.andThen(Deferred.succeed(lateObserved, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Effect.yieldNow;
          yield* PubSub.publish(nativeEvents, {
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            threadId: claudeThreadId,
            turnId: turnA,
            type: "content.delta",
            eventId: EventId.make("merged-assistant-delta"),
            createdAt: "2026-09-14T12:00:00.000Z",
            payload: { streamKind: "assistant_text", delta: "One shared answer." },
          });
          yield* PubSub.publish(nativeEvents, terminal(turnA, "terminal-a"));
          yield* Deferred.succeed(releaseSecondDispatch, undefined);
          yield* Fiber.join(secondSend);
          yield* Deferred.await(lateObserved);
          yield* Deferred.await(terminalObserved);
          assert.equal(
            (yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId)))
              .acceptedPromptCount,
            12,
          );
          expect(mastra.observeExternalTurn).toHaveBeenCalledTimes(1);
          expect(mastra.observeExternalTurn).toHaveBeenCalledWith(
            expect.objectContaining({
              turnId: String(turnA),
              userMessages: [
                { id: expect.any(String), text: "Turn A" },
                { id: expect.any(String), text: "Turn B" },
              ],
              assistant: "One shared answer.",
            }),
          );
          const observedUsers = (
            mastra.observeExternalTurn.mock.calls as unknown as ReadonlyArray<
              readonly [{ readonly userMessages: ReadonlyArray<{ readonly id: string }> }]
            >
          )[0]?.[0].userMessages;
          expect(new Set(observedUsers?.map((entry) => entry.id)).size).toBe(2);
          yield* Fiber.interrupt(lateFiber);
          yield* Fiber.interrupt(streamFiber);
        }),
        service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
        ),
      );
    }),
  );

  it.effect("settles a legacy terminal event that races before sendTurn returns", () =>
    Effect.gen(function* () {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const nativeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const dispatchEntered = yield* Deferred.make<void>();
      const releaseDispatch = yield* Deferred.make<void>();
      const turnId = TurnId.make("legacy-racing-turn");
      bridge.sendTurn.mockImplementationOnce((input) =>
        Deferred.succeed(dispatchEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseDispatch)),
          Effect.as({ threadId: input.threadId, turnId }),
        ),
      );
      const memoryDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "akeru-racing-terminal-"),
      );
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-racing-terminal");

      yield* provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* controller.resolveEngine({
            threadId: claudeThreadId,
            engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(claudeThreadId, {
            threadId: claudeThreadId,
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            runtimeMode: "approval-required",
            memoryAccess: {
              tenantId: AkeruMemoryTenantId.make("local"),
              userId: AkeruMemoryUserId.make("owner"),
              threadId: claudeThreadId,
              projectId: ProjectId.make("project-racing-terminal"),
              workspaceRoot: "/workspace/racing-terminal",
              botId,
              groupId: null,
              respondingBotId: botId,
              groupMemberBotIds: [],
            },
          });
          const processed = yield* Deferred.make<void>();
          const streamFiber = yield* controller.streamEvents.pipe(
            Stream.runForEach(() => Deferred.succeed(processed, undefined).pipe(Effect.ignore)),
            Effect.forkChild({ startImmediately: true }),
          );
          const sendFiber = yield* controller
            .sendTurn({ threadId: claudeThreadId, input: "Racing terminal." })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(dispatchEntered);
          yield* PubSub.publish(nativeEvents, {
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            threadId: claudeThreadId,
            turnId,
            type: "turn.completed",
            eventId: EventId.make("racing-terminal"),
            createdAt: "2026-09-14T12:00:00.000Z",
            payload: { state: "completed", stopReason: null },
          });
          yield* Deferred.await(processed);
          yield* Deferred.succeed(releaseDispatch, undefined);
          yield* Fiber.join(sendFiber);
          assert.equal(
            (yield* Effect.promise(() => botMemoryStore.readReviewCadence(botId)))
              .acceptedPromptCount,
            1,
          );
          yield* Fiber.interrupt(streamFiber);
        }),
        { ...bridge.service, streamEvents: Stream.fromPubSub(nativeEvents) },
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
        ),
      );
    }),
  );

  it.effect("feeds completed legacy-provider turns into observational memory", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const events: ProviderRuntimeEvent[] = [
      {
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: openCodeInstanceId,
        threadId: claudeThreadId,
        turnId: TurnId.make("legacy-turn"),
        type: "content.delta",
        eventId: EventId.make("legacy-memory-delta"),
        createdAt: "2026-09-13T20:00:00.000Z",
        payload: {
          delta: "The completed legacy answer.",
          streamKind: "assistant_text",
        },
      },
      {
        provider: ProviderDriverKind.make("opencode"),
        providerInstanceId: openCodeInstanceId,
        threadId: claudeThreadId,
        turnId: TurnId.make("legacy-turn"),
        type: "turn.completed",
        eventId: EventId.make("legacy-memory-complete"),
        createdAt: "2026-09-13T20:00:01.000Z",
        payload: { state: "completed", stopReason: null },
      },
    ];
    const service = { ...bridge.service, streamEvents: Stream.fromIterable(events) };

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "gpt-5.6" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: openCodeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({ threadId: claudeThreadId, input: "Remember this turn." });
        yield* controller.streamEvents.pipe(Stream.take(2), Stream.runDrain);
        yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));

        expect(mastra.observeExternalTurn).toHaveBeenCalledWith({
          threadId: String(claudeThreadId),
          turnId: "legacy-turn",
          modelId: "opencode/gpt-5.6",
          userMessages: [
            {
              id: expect.any(String),
              text: "Remember this turn.",
            },
          ],
          assistant: "The completed legacy answer.",
          createdAt: "2026-09-13T20:00:01.000Z",
        });
      }),
      service,
      mastra.factory,
    );
  });

  it.effect("runs the saved Kimi model through Mastra without provider fallback", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: kimiThreadId,
          engine: { provider: String(kimiInstanceId), model: "k3-256k" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        const session = yield* controller.startSession(kimiThreadId, {
          threadId: kimiThreadId,
          provider: ProviderDriverKind.make("kimi"),
          providerInstanceId: kimiInstanceId,
          cwd: process.cwd(),
          modelSelection: { instanceId: kimiInstanceId, model: "k3-256k" },
          runtimeMode: "approval-required",
        });

        assert.equal(session.provider, "kimi");
        assert.equal(session.model, "k3-256k");
        expect(mastra.session.model.switch).toHaveBeenCalledWith({
          modelId: "kimi-for-coding/k3-256k",
        });
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.getCapabilities).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("rejects an OpenCode Go turn after the provider is disabled", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: openCodeGoThreadId,
          engine: { provider: String(openCodeGoInstanceId), model: "gpt-5.6-luna" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(openCodeGoThreadId, {
          threadId: openCodeGoThreadId,
          provider: ProviderDriverKind.make("opencodeGo"),
          providerInstanceId: openCodeGoInstanceId,
          cwd: process.cwd(),
          modelSelection: { instanceId: openCodeGoInstanceId, model: "gpt-5.6-luna" },
          runtimeMode: "approval-required",
        });

        bridge.setInstanceEnabled(false);
        const error = yield* controller
          .sendTurn({ threadId: openCodeGoThreadId, input: "Do not run this turn." })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderValidationError");
        if (error._tag === "ProviderValidationError") {
          assert.include(error.issue, "disabled in Akeru Bot settings");
        }
        expect(mastra.sendMessage).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("rejects an OpenCode Go turn disabled during dispatch admission", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: openCodeGoThreadId,
          engine: { provider: String(openCodeGoInstanceId), model: "gpt-5.6-luna" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(openCodeGoThreadId, {
          threadId: openCodeGoThreadId,
          provider: ProviderDriverKind.make("opencodeGo"),
          providerInstanceId: openCodeGoInstanceId,
          cwd: process.cwd(),
          modelSelection: { instanceId: openCodeGoInstanceId, model: "gpt-5.6-luna" },
          runtimeMode: "approval-required",
        });

        bridge.disableBeforeNextDispatchAdmission();
        const error = yield* controller
          .sendTurn({ threadId: openCodeGoThreadId, input: "Do not dispatch this turn." })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderValidationError");
        expect(mastra.sendMessage).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("rejects an OpenCode Go approval after the provider is disabled", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: openCodeGoThreadId,
          engine: { provider: String(openCodeGoInstanceId), model: "gpt-5.6-luna" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(openCodeGoThreadId, {
          threadId: openCodeGoThreadId,
          provider: ProviderDriverKind.make("opencodeGo"),
          providerInstanceId: openCodeGoInstanceId,
          cwd: process.cwd(),
          modelSelection: { instanceId: openCodeGoInstanceId, model: "gpt-5.6-luna" },
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({ threadId: openCodeGoThreadId, input: "Run a tool." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "disabled-approval",
          toolName: "Shell",
          args: { command: "pwd" },
        } as AgentControllerEvent);

        bridge.disableBeforeNextDispatchAdmission();
        const error = yield* controller
          .respondToRequest({
            threadId: openCodeGoThreadId,
            requestId: ApprovalRequestId.make("disabled-approval"),
            decision: "accept",
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderValidationError");
        expect(mastra.session.respondToToolApproval).not.toHaveBeenCalled();
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("rejects OpenCode Go user input after the provider is disabled", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: openCodeGoThreadId,
          engine: { provider: String(openCodeGoInstanceId), model: "gpt-5.6-luna" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(openCodeGoThreadId, {
          threadId: openCodeGoThreadId,
          provider: ProviderDriverKind.make("opencodeGo"),
          providerInstanceId: openCodeGoInstanceId,
          cwd: process.cwd(),
          modelSelection: { instanceId: openCodeGoInstanceId, model: "gpt-5.6-luna" },
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({ threadId: openCodeGoThreadId, input: "Ask for input." });
        mastra.emit({
          type: "tool_suspended",
          toolCallId: "disabled-user-input",
          toolName: "ask_user",
          args: {},
          suspendPayload: {},
        } as AgentControllerEvent);

        bridge.disableBeforeNextDispatchAdmission();
        const error = yield* controller
          .respondToUserInput({
            threadId: openCodeGoThreadId,
            requestId: ApprovalRequestId.make("disabled-user-input"),
            answers: { "disabled-user-input": "Continue" },
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderValidationError");
        expect(mastra.session.respondToToolSuspension).not.toHaveBeenCalled();
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("applies saved Codex options to initial and active Mastra sessions", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: codexThreadId,
          engine: {
            provider: "codex",
            model: "gpt-5.6-sol",
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "priority" },
            ],
          },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({
            modelOptions: { reasoningEffort: "high", serviceTier: "priority" },
          }),
        );

        yield* controller.resolveEngine({
          threadId: codexThreadId,
          engine: {
            provider: "codex",
            model: "gpt-5.6-sol",
            options: [
              { id: "reasoningEffort", value: "low" },
              { id: "serviceTier", value: "flex" },
            ],
          },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });

        expect(mastra.session.state.set).toHaveBeenLastCalledWith(
          expect.objectContaining({
            modelOptions: { reasoningEffort: "low", serviceTier: "flex" },
          }),
        );
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("stops a legacy session after resolving the thread to Codex", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const legacySession = makeProviderSession(codexThreadId, "claudeAgent");
    const service: ProviderServiceShape = {
      ...bridge.service,
      listSessions: () => Effect.succeed([legacySession]),
    };

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: codexThreadId,
          engine: { provider: "claudeAgent", model: "claude-fable-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: false,
        });
        yield* controller.resolveEngine({
          threadId: codexThreadId,
          engine: { provider: "codex", model: "gpt-5.6-sol" },
          fallback: codexSelection,
          mode: "default",
          botConversation: false,
        });
        yield* controller.stopSession({ threadId: codexThreadId });

        expect(bridge.stopSession).toHaveBeenCalledWith({ threadId: codexThreadId });
      }),
      service,
      mastra.factory,
    );
  });

  it.effect("does not fall back to the legacy Codex loop when its Mastra session is absent", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const error = yield* controller
          .sendTurn({ threadId: codexThreadId, input: "No legacy fallback." })
          .pipe(Effect.flip);

        assert.equal(error._tag, "AgentControllerRuntimeError");
        expect(bridge.sendTurn).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("does not fall back to the legacy Kimi loop when its Mastra session is absent", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: kimiThreadId,
          engine: { provider: String(kimiInstanceId), model: "k3-256k" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        const error = yield* controller
          .sendTurn({ threadId: kimiThreadId, input: "No legacy fallback." })
          .pipe(Effect.flip);

        assert.equal(error._tag, "AgentControllerRuntimeError");
        expect(bridge.sendTurn).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});
