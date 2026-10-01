// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentControllerEvent, MastraDBMessage, Session } from "@mastra/core/agent-controller";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  DEFAULT_SERVER_SETTINGS,
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryPartitionId,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  ApprovalRequestId,
  BotId,
  DelegationId,
  EnvironmentId,
  EventId,
  GroupId,
  McpServerId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  RoutineId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type AkeruDelegationAccessGrant,
  type AkeruMemoryRevision,
  type McpServer,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerSettings,
} from "@akeru/contracts";
import type { AkeruUsageEntry } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assert, describe, expect, vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import {
  ServerSettingsService,
  layerTest as serverSettingsLayerTest,
} from "../../serverSettings.ts";
import { BotInboxService } from "../../bot-inbox/service.ts";
import { BotMemoryStore } from "../../memory/BotMemory.ts";
import { createBotMemoryToolHandler } from "../../memory/BotMemoryToolHandlers.ts";
import { EntityMemoryRepository } from "../../memory/Services/EntityMemoryRepository.ts";
import * as McpMemoryToolSession from "../../mcp/McpMemoryToolSession.ts";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import { AgentController } from "../Services/AgentController.ts";
import { makeAkeruMastraHarness, type AkeruMastraHarness } from "../AkeruMastraHarness.ts";
import type { AkeruRuntimeToolId } from "../AkeruToolRuntime.ts";
import { AgentControllerRuntimeError, ProviderValidationError } from "../Errors.ts";
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
  usesMastraCode,
  type AgentControllerLiveOptions,
} from "./AgentController.ts";
import {
  ImageGenerationRuntime,
  layerWith as imageGenerationRuntimeLayerWith,
  type ImageSubscriptionAuth,
} from "../../image-generation/ImageGenerationRuntime.ts";
import {
  GROK_IMAGE_CAPABILITIES,
  makeChatGptImageAdapter,
  type ImageProviderAdapter,
} from "../../image-generation/adapters.ts";
import { pngBytes } from "../../image-generation/testImages.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionBotRepository } from "../../persistence/Services/ProjectionBots.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../../persistence/Services/ProjectionTurns.ts";
import { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import { makeTestSubscriptionAuthService } from "../../subscription-auth/testUtils/subscriptionAuthService.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  RoutineDraftDispatcher,
  RoutineDraftError,
  type RoutineDraftDispatcherShape,
} from "../../routines/RoutineDraftDispatcher.ts";
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

class MemoryToolCallError extends Data.TaggedError("MemoryToolCallError")<{
  readonly cause: Error;
}> {}

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
  provider: "codex" | "claudeAgent" | "opencode",
): ProviderSession {
  return {
    provider: ProviderDriverKind.make(provider),
    providerInstanceId: ProviderInstanceId.make(provider),
    threadId,
    status: "ready",
    runtimeMode: "full-access",
    model:
      provider === "codex"
        ? "gpt-5.6-sol"
        : provider === "opencode"
          ? "anthropic/claude-sonnet-4-5"
          : "claude-fable-5",
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

const instanceModelCatalog = new Map<
  string,
  { readonly models: ReadonlyArray<string>; readonly status?: "ready" | "warning" | "error" }
>();

function makeInstanceSnapshot(
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  entry: {
    readonly models: ReadonlyArray<string>;
    readonly status?: "ready" | "warning" | "error";
  },
) {
  return {
    instanceId,
    driver: driverKind,
    enabled: true,
    installed: true,
    version: null,
    status: entry.status ?? ("ready" as const),
    auth: { status: "authenticated" as const },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: entry.models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

function makeBridge() {
  instanceModelCatalog.clear();
  let instanceEnabled = true;
  let disableBeforeNextDispatchAdmission = false;
  let nextDispatchAdmissionWait: Promise<void> | undefined;
  let releaseNextDispatchAdmission: (() => void) | undefined;
  let nextDispatchAdmissionReached = Promise.resolve();
  let markNextDispatchAdmissionReached: (() => void) | undefined;
  const startSession = vi.fn<ProviderServiceShape["startSession"]>((threadId, input) =>
    Effect.succeed(
      makeProviderSession(
        threadId,
        String(input.provider) === "codex"
          ? "codex"
          : String(input.provider) === "opencode"
            ? "opencode"
            : "claudeAgent",
      ),
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
        const advertisedModels = instanceModelCatalog.get(String(instanceId));
        return {
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: instanceEnabled,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
          ...(advertisedModels !== undefined
            ? {
                instanceSnapshot: makeInstanceSnapshot(instanceId, driverKind, advertisedModels),
              }
            : {}),
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

/** Current entity facts in each bot-private and shared scope, for packet policy tests. */
function privatePolicyRevisions(botId: BotId, projectId: ProjectId): Array<AkeruMemoryRevision> {
  const revision = (scope: AkeruMemoryRevision["partition"]["scope"], fact: string) =>
    ({
      id: AkeruMemoryId.make(`memory-${scope}`),
      rootId: AkeruMemoryRootId.make(`memory-${scope}`),
      revision: 1,
      partition: {
        tenantId: AkeruMemoryTenantId.make("local"),
        scope,
        partitionId: AkeruMemoryPartitionId.make(`${scope}-partition`),
      },
      entityKind: scope === "project" ? "project" : "bot",
      entityId: AkeruMemoryEntityId.make(scope === "project" ? String(projectId) : String(botId)),
      kind: "fact",
      value: {},
      fact,
      sourceThreadId: null,
      sourceMessageId: null,
      authorBotId: botId,
      initiatingUserId: AkeruMemoryUserId.make("owner"),
      createdAt: "2026-09-01T00:00:00.000Z",
      confirmedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      confidence: 0.5,
      approvalState: "approved",
      supersedesId: null,
      supersededById: null,
      visibility: scope === "project" ? "shared" : "private",
      deletionState: "active",
      pinned: false,
      sensitive: false,
      affectedBotIds: [botId],
    }) as AkeruMemoryRevision;
  return [
    revision("bot", "Bot-private entity fact."),
    revision("bot-user", "Bot-about-you entity fact."),
    revision("project", "Shared project entity fact."),
  ];
}

function entityMemorySection(context: unknown): string {
  const match = /<entity-memory>[\s\S]*?<\/entity-memory>/u.exec(String(context ?? ""));
  return match?.[0] ?? "";
}

function makeMemoryOnlyCredentialOptions() {
  const requests: Array<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly capabilities?: ReadonlySet<McpCapability>;
  }> = [];
  const revoked: Array<ThreadId> = [];
  return {
    requests,
    revoked,
    issueMcpCredential: (request: (typeof requests)[number]) => {
      requests.push(request);
      if (!request.capabilities?.has("memory")) return Effect.succeed(undefined);
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
  const recordMeasurement = vi.fn<BotUsageLedgerShape["recordMeasurement"]>(() =>
    Effect.succeed({} as never),
  );
  const recordStart = vi.fn<BotUsageLedgerShape["recordStart"]>(() => Effect.succeed({} as never));
  const unused = () => Effect.die("unused");
  return {
    reserve,
    settle,
    recordMeasurement,
    recordStart,
    service: BotUsageLedger.of({
      reserve,
      settle,
      bindTurn: unused,
      settleForTurn: unused,
      finalizeForTurn: unused,
      recordMeasurement,
      recordStart,
      summarize: unused,
      pricingTotals: unused,
    }),
  };
}

// makeMastraHarness returns one shared Session double for every createSession call.
// Multi-thread tests must install their own factory (see "routes two bots on the same
// Codex instance") or the same session spies would collapse every thread together.
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
  const observeExternalTurn = vi.fn(async () => undefined);
  const factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]> = (options) =>
    Effect.sync(() => {
      harnessOptions.push(options);
      return {
        controller: {
          init: vi.fn(async () => undefined),
          createSession,
          deleteSession,
        },
        observeExternalTurn,
      };
    });
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
    | "webFetch"
    | "generateImage"
    | "readAttachment"
  >,
  delegationRuntime?: AgentControllerLiveOptions["delegationRuntime"],
  settingsOverrides?: Parameters<typeof serverSettingsLayerTest>[0],
  settingsLayer?: Layer.Layer<ServerSettingsService>,
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
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(LegacyProviderBridge, bridge),
        Layer.succeed(BotUsageLedger, usageLedger),
        Layer.mock(EntityMemoryRepository)({}),
        settingsLayer ?? serverSettingsLayerTest(settingsOverrides ?? {}),
        ServerConfig.layerTest(
          process.cwd(),
          baseDir ?? { prefix: "akeru-mastra-controller-test-" },
        ).pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
      ),
    ),
  );
}

function provideController<A, E>(
  effect: Effect.Effect<
    A,
    E,
    AgentController | ServerSettingsService | FileSystem.FileSystem | Path.Path
  >,
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
    | "webFetch"
    | "generateImage"
    | "readAttachment"
  >,
  settingsOverrides?: Parameters<typeof serverSettingsLayerTest>[0],
  settingsLayer?: Layer.Layer<ServerSettingsService>,
) {
  return effect.pipe(
    Effect.provide(
      makeLayer(
        bridge,
        factory,
        makeMcpManager,
        baseDir,
        usageLedger,
        overrides,
        undefined,
        settingsOverrides,
        settingsLayer,
      ),
    ),
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

describe("usesMastraCode", () => {
  it("gives catalog tools, workers included, only to Mastra-backed providers", () => {
    for (const provider of ["codex", "claudeAgent", "grok", "kimi", "opencodeGo"]) {
      expect(usesMastraCode(ProviderDriverKind.make(provider))).toBe(true);
    }
    // Standard OpenCode runs on the legacy bridge, which registers no tool session.
    expect(usesMastraCode(ProviderDriverKind.make("opencode"))).toBe(false);
  });
});

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

  it("records a failed first request and recovery at the runtime event boundary", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-health-"));
    const authPath = NodePath.join(directory, "subscription-auth.json");
    try {
      NodeFS.writeFileSync(
        authPath,
        JSON.stringify({
          xai: { type: "oauth", access: "a", refresh: "r", expires: 1_900_000_000_000 },
        }),
      );
      const service = await makeTestSubscriptionAuthService(authPath);
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

  it("records the model a failed turn ran on with the instance failure", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-model-"));
    try {
      const service = await makeTestSubscriptionAuthService(
        NodePath.join(directory, "subscription-auth.json"),
      );
      recordProviderAccessHealth(
        service,
        {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId: ThreadId.make("thread-model"),
          turnId: TurnId.make("turn-model"),
          type: "turn.completed",
          eventId: EventId.make("evt-model-failed"),
          createdAt: "2026-08-30T20:00:00.000Z",
          payload: { state: "failed", stopReason: null, errorMessage: "Model gpt-typo not found" },
        },
        "gpt-typo",
      );

      expect(service.providerInstanceRequestHealth("codex")?.lastFailedRequest).toEqual({
        at: "2026-08-30T20:00:00.000Z",
        message: "Model gpt-typo not found",
        model: "gpt-typo",
      });
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["interrupted", "cancelled"] as const)(
    "does not call a %s turn a successful provider request",
    async (state) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-stop-"));
      const authPath = NodePath.join(directory, "subscription-auth.json");
      try {
        const service = await makeTestSubscriptionAuthService(authPath);
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

/** An image runtime over fake adapters for one running chat, plus the commands and usage it records. */
function makeImageRuntimeTestLayer(input: {
  readonly baseDir: string;
  readonly adapters: Readonly<Record<"chatgpt" | "grok", ImageProviderAdapter>>;
  readonly connected: ReadonlyArray<"openai-codex" | "xai">;
  readonly settings: { readonly chatgptEnabled?: boolean; readonly grokEnabled?: boolean };
  readonly botProvider: "chatgpt" | "grok" | null;
  readonly requestTimeout?: Duration.Input;
}) {
  const dispatched: OrchestrationCommand[] = [];
  const imageUsage: Array<unknown> = [];
  const subscriptionAuth: ImageSubscriptionAuth = {
    statuses: () =>
      input.connected.map((provider) => ({
        provider,
        connected: true,
        health: "healthy" as const,
        reconnectAction: "",
        healthTest: { status: "not-run" as const },
        dependentBots: [],
        dependentRoutines: [],
      })),
    recordImageGenerationSuccess: () => undefined,
    recordImageRequestFailure: () => undefined,
  };
  const layer = imageGenerationRuntimeLayerWith({
    adapters: input.adapters,
    subscriptionAuth,
    ...(input.requestTimeout ? { requestTimeout: input.requestTimeout } : {}),
  }).pipe(
    Layer.provideMerge(
      Layer.succeed(
        OrchestrationEngine.OrchestrationEngineService,
        OrchestrationEngine.OrchestrationEngineService.of({
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              latestTurn: {
                state: "running",
                turnId: TurnId.make("turn-image"),
                respondingBotId: BotId.make("bot-image"),
                requestedAt: "2026-01-01T00:00:00.000Z",
                startedAt: null,
                completedAt: null,
                assistantMessageId: null,
              },
              respondingBotId: BotId.make("bot-image"),
              botId: BotId.make("bot-image"),
            }),
          ),
      } as never),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionBotRepository, {
        getById: () =>
          Effect.succeed(
            Option.some({ id: BotId.make("bot-image"), imageProvider: input.botProvider }),
          ),
      } as never),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadMessageRepository, {
        listByThreadId: () => Effect.succeed([]),
      } as never),
    ),
    Layer.provideMerge(serverSettingsLayerTest({ imageGeneration: input.settings })),
    Layer.provideMerge(
      Layer.succeed(
        BotUsageLedger,
        BotUsageLedger.of({
          ...makeUsageLedger().service,
          recordMeasurement: (measurement) =>
            Effect.sync(() => {
              imageUsage.push(measurement);
              return {
                ...measurement,
                state: "reported",
                reservedTokens: 0,
                unavailableReason: null,
                settledAt: measurement.createdAt,
              } as AkeruUsageEntry;
            }),
        }),
      ),
    ),
    Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, {} as never)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, dispatched, imageUsage };
}

describe("AgentControllerLive", () => {
  it.effect.each(["codex", "kimi"] as const)(
    "restarts %s with only retained turns in the next turn's Mastra context",
    (provider) => {
      const bridge = makeBridge();
      const threadId = provider === "codex" ? codexThreadId : kimiThreadId;
      const selection =
        provider === "codex" ? codexSelection : { instanceId: kimiInstanceId, model: "k3-256k" };
      const createdAt = "2026-01-01T00:00:00.000Z";
      const attachment = {
        type: "image" as const,
        id: `${threadId}-12345678-1234-1234-1234-123456789abc`,
        name: "retained.png",
        mimeType: "image/png",
        sizeBytes: 1,
      };
      const messages: ProjectionThreadMessage[] = [1, 2].flatMap((count) =>
        (["user", "assistant"] as const).map((role) => ({
          messageId: MessageId.make(`${role}-${count}`),
          threadId,
          turnId: role === "user" ? null : TurnId.make(`turn-${count}`),
          role,
          text: `${role} turn ${count}`,
          isStreaming: false,
          createdAt,
          updatedAt: createdAt,
          attachments: count === 1 && role === "user" ? [attachment] : [],
        })),
      );
      const turns: ProjectionTurn[] = [1, 2].map((count) => ({
        threadId,
        turnId: TurnId.make(`turn-${count}`),
        pendingMessageId: MessageId.make(`user-${count}`),
        assistantMessageId: MessageId.make(`assistant-${count}`),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        respondingBotId: null,
        state: "completed",
        requestedAt: createdAt,
        startedAt: createdAt,
        completedAt: createdAt,
        checkpointTurnCount: count,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      }));
      const nextContext = Promise.withResolvers<MastraDBMessage[]>();
      const dispatchStarted = Promise.withResolvers<void>();
      const finishDispatch = Promise.withResolvers<void>();
      const dispatchAborted = Promise.withResolvers<void>();
      const sessions: Session<Record<string, unknown>>[] = [];
      let harness: AkeruMastraHarness | undefined;
      let failRestart = false;
      const factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]> = (options) =>
        Effect.gen(function* () {
          const real = yield* makeAkeruMastraHarness(options);
          harness = real;
          yield* Effect.promise(() =>
            real.rebuildConversation!(
              String(threadId),
              messages.map((message) => ({
                id: String(message.messageId),
                role: message.role,
                content: { format: 2, parts: [{ type: "text", text: message.text }] },
                createdAt: new Date(message.createdAt),
                threadId: String(threadId),
                resourceId: String(threadId),
              })),
            ),
          );
          return {
            ...real,
            observeAfterTurn: async () => undefined,
            controller: {
              ...real.controller,
              init: () => real.controller.init(),
              deleteSession: (input) => real.controller.deleteSession(input),
              createSession: async (input) => {
                if (failRestart) {
                  failRestart = false;
                  throw new Error("Restart failed");
                }
                const session = await real.controller.createSession(input);
                sessions.push(session);
                if (sessions.length === 1) {
                  const abort = session.abort.bind(session);
                  vi.spyOn(session, "abort").mockImplementation(() => {
                    abort();
                    dispatchAborted.resolve();
                  });
                }
                vi.spyOn(session, "sendMessage").mockImplementation(async () => {
                  if (sessions.length === 1) {
                    dispatchStarted.resolve();
                    await finishDispatch.promise;
                    return;
                  }
                  nextContext.resolve(await session.thread.listActiveMessages());
                });
                return session;
              },
            },
          };
        });
      return Effect.gen(function* () {
        const controller = yield* AgentController;
        const config = yield* ServerConfig;
        NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${attachment.id}.png`), "x");
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
          providerInstanceId: selection.instanceId,
          modelSelection: selection,
          runtimeMode: "approval-required",
          cwd: process.cwd(),
        });
        const before = yield* Effect.promise(() => sessions[0]!.thread.listActiveMessages());
        expect(before.map((message) => message.id)).toEqual([
          "user-1",
          "assistant-1",
          "user-2",
          "assistant-2",
        ]);
        yield* Effect.promise(() =>
          harness!.restoreObservationalMemory!(String(threadId), {
            current: {
              id: "discarded-observation",
              generationCount: 1,
              activeObservations: "Facts from discarded turn 2",
              bufferedObservations: "",
              bufferedReflection: null,
              totalTokensObserved: 10,
              observationTokenCount: 2,
              createdAt,
              updatedAt: createdAt,
              originType: "initial",
            },
            history: [],
          }),
        );
        yield* controller.sendTurn({ threadId, input: "Discarded in-flight turn" });
        yield* Effect.promise(() => dispatchStarted.promise);
        const rollback = yield* controller
          .rollbackConversation({ threadId, numTurns: 1 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => dispatchAborted.promise);
        expect(sessions).toHaveLength(1);
        finishDispatch.resolve();
        yield* Fiber.join(rollback);
        expect(
          yield* Effect.promise(() => harness!.readObservationalMemory!(String(threadId))),
        ).toEqual({ current: null, history: [] });
        expect(sessions).toHaveLength(2);
        expect(sessions[1]).not.toBe(sessions[0]);
        yield* controller.sendTurn({ threadId, input: "Next turn" });
        const context = yield* Effect.promise(() => nextContext.promise);
        expect(context.map((message) => message.id)).toEqual(["user-1", "assistant-1"]);
        expect(context[0]?.content.parts).toEqual([
          {
            type: "text",
            text: `user turn 1\n\n[Attached image "retained.png" is saved at: ${NodePath.join(config.attachmentsDir, `${attachment.id}.png`)}]`,
          },
        ]);
        expect(context[0]?.content.experimental_attachments).toEqual([
          {
            name: "retained.png",
            contentType: "image/png",
            url: "data:image/png;base64,eA==",
          },
        ]);
        expect(context[1]?.content.parts).toEqual([{ type: "text", text: "assistant turn 1" }]);
        yield* controller.interruptTurn({ threadId });
        turns.splice(1);
        messages.splice(2);
        failRestart = true;
        const failedRestart = yield* controller
          .rollbackConversation({ threadId, numTurns: 1 })
          .pipe(Effect.exit);
        expect(Exit.isFailure(failedRestart)).toBe(true);
        // The original session reopens without another start request.
        expect(sessions).toHaveLength(3);
        expect(
          (yield* Effect.promise(() => sessions[2]!.thread.listActiveMessages())).map(
            (message) => message.id,
          ),
        ).toEqual(["user-1", "assistant-1"]);
        yield* controller.rollbackConversation({ threadId, numTurns: 1 });
        expect(sessions).toHaveLength(4);
        expect(yield* Effect.promise(() => sessions[3]!.thread.listActiveMessages())).toEqual([]);
        yield* controller.stopSession({ threadId });
        yield* controller.startSession(threadId, {
          threadId,
          modelSelection: selection,
          runtimeMode: "approval-required",
        });
        expect(yield* Effect.promise(() => sessions[4]!.thread.listActiveMessages())).toEqual([]);
        expect(bridge.rollbackConversation).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(
          makeLayer(bridge.service, factory).pipe(
            Layer.provide(
              Layer.mock(ProjectionThreadMessageRepository)({
                listByThreadId: () => Effect.succeed(messages),
              }),
            ),
            Layer.provide(
              Layer.mock(ProjectionTurnRepository)({
                listByThreadId: () => Effect.succeed(turns),
              }),
            ),
          ),
        ),
      );
    },
  );
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
        send: vi.fn(async () => ({
          delegationId: DelegationId.make("delegation-child"),
          childThreadId: ThreadId.make("thread-child"),
          childBotId: BotId.make("bot-child"),
          name: "Child",
          phase: "running" as const,
        })),
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

      expect(parentFinished).toHaveBeenCalledWith({
        threadId: codexThreadId,
        turnId: expect.any(String),
        failed: false,
      });
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
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

  it.effect("records tool calls without holding bot token capacity", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const usage = makeUsageLedger();
    const botId = BotId.make("bot-tool-usage");
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
          botId,
          memoryAccess: {
            tenantId: AkeruMemoryTenantId.make("local"),
            userId: AkeruMemoryUserId.make("owner"),
            threadId: codexThreadId,
            projectId: ProjectId.make("project-tool-usage"),
            workspaceRoot: "/workspace/tool-usage",
            botId,
            groupId: null,
            respondingBotId: botId,
            groupMemberBotIds: [],
          },
        });
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "memory",
            toolCallId: "usage-tool-call",
            input: { target: "user", operations: [] },
            approvalMode: "require-grant",
          }),
        );

        expect(usage.reserve).not.toHaveBeenCalled();
        expect(usage.recordStart).toHaveBeenCalledTimes(1);
        expect(usage.recordStart.mock.calls[0]?.[0]).toMatchObject({
          reservationId: `tool:${codexThreadId}:usage-tool-call`,
          sourceKey: `tool:${codexThreadId}:usage-tool-call`,
          botId,
          category: "tool",
        });
        expect(usage.settle).toHaveBeenCalledTimes(1);
        expect(usage.settle.mock.calls[0]?.[0]).toMatchObject({
          reservationId: `tool:${codexThreadId}:usage-tool-call`,
          state: "reported",
          inputTokens: 0,
          outputTokens: 0,
        });
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      usage.service,
    );
  });

  it.effect("records the whole tool entry at finish when the start write fails", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const usage = makeUsageLedger();
    usage.recordStart.mockImplementation(() => Effect.die(new Error("ledger unavailable")));
    const botId = BotId.make("bot-tool-usage");
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
          botId,
          memoryAccess: {
            tenantId: AkeruMemoryTenantId.make("local"),
            userId: AkeruMemoryUserId.make("owner"),
            threadId: codexThreadId,
            projectId: ProjectId.make("project-tool-usage"),
            workspaceRoot: "/workspace/tool-usage",
            botId,
            groupId: null,
            respondingBotId: botId,
            groupMemberBotIds: [],
          },
        });
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "memory",
            toolCallId: "usage-tool-call",
            input: { target: "user", operations: [] },
            approvalMode: "require-grant",
          }),
        );

        expect(usage.recordStart).toHaveBeenCalledTimes(1);
        expect(usage.settle).not.toHaveBeenCalled();
        expect(usage.recordMeasurement).toHaveBeenCalledTimes(1);
        expect(usage.recordMeasurement.mock.calls[0]?.[0]).toMatchObject({
          reservationId: `tool:${codexThreadId}:usage-tool-call`,
          sourceKey: `tool:${codexThreadId}:usage-tool-call`,
          botId,
          category: "tool",
          inputTokens: 0,
          outputTokens: 0,
        });
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      usage.service,
    );
  });

  it.effect("exposes and runs the web, image, and MCP catalog tools in a live session", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-catalog-tools-"));
    const page = NodeHttp.createServer((_request, response) => response.end("catalog page"));
    const imageResult = {
      status: "needs-consent",
      provider: "grok",
      message: "ask first",
      attempts: [],
    };
    const generateImage = vi.fn((_threadId: ThreadId, _input: unknown) =>
      Effect.succeed(imageResult),
    );
    const dispatched: OrchestrationCommand[] = [];
    const docsServer: McpServer = {
      id: McpServerId.make("docs"),
      name: "Docs",
      transport: "url",
      url: "https://mcp.example.com/docs",
      enabled: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      instructions: "Search the docs first.",
    };
    const localServer: McpServer = {
      id: McpServerId.make("local"),
      name: "Local",
      transport: "stdio",
      command: "npx",
      args: ["-y", "local-mcp"],
      enabled: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    // Ada uses both servers, Grace turned docs off, and archived Linus turned local off.
    const snapshotBots = [
      { id: BotId.make("ada"), name: "Ada", archivedAt: null, disabledMcpServerIds: [] },
      {
        id: BotId.make("grace"),
        name: "Grace",
        archivedAt: null,
        disabledMcpServerIds: [McpServerId.make("docs"), McpServerId.make("other")],
      },
      {
        id: BotId.make("linus"),
        name: "Linus",
        archivedAt: "2026-09-02T00:00:00.000Z",
        disabledMcpServerIds: [McpServerId.make("local")],
      },
    ];

    return provideController(
      Effect.gen(function* () {
        yield* Effect.promise(
          () => new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve)),
        );
        const port = (page.address() as NodeNet.AddressInfo).port;
        const controller = yield* AgentController;
        yield* controller.configurePluginRuntime!({
          readSnapshot: async () =>
            ({
              bots: snapshotBots,
              mcpServers: [docsServer, localServer],
            }) as unknown as OrchestrationReadModel,
          dispatch: async (command) => {
            dispatched.push(command);
            // Grace saves another disabled server while docs is being removed;
            // the sweep must keep that newer choice.
            if (command.type === "mcp-server.delete" && command.mcpServerId === "docs") {
              snapshotBots[1]!.disabledMcpServerIds = [
                ...snapshotBots[1]!.disabledMcpServerIds,
                McpServerId.make("newer"),
              ];
            }
            return { sequence: dispatched.length };
          },
        });
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).toEqual(
          expect.arrayContaining([
            "WebSearch",
            "WebFetch",
            "GenerateImage",
            "AddMcpServer",
            "UninstallMcpServer",
            "RemoveMcpAccount",
            "RenameMcpAccount",
            "SetMcpInstructions",
          ]),
        );
        const run = (toolId: AkeruRuntimeToolId, toolCallId: string, input: unknown) =>
          Effect.promise(() => {
            const execution = { threadId: String(codexThreadId), toolId, toolCallId, input };
            runtime.grantApproval(execution);
            return runtime.execute({ ...execution, approvalMode: "require-grant" });
          });

        expect(yield* run("WebSearch", "search", { query: "akeru bot" })).toMatchObject({
          status: "unavailable",
          query: "akeru bot",
          results: [],
        });
        expect(
          yield* run("WebFetch", "fetch", { url: `http://catalog.example:${port}/` }),
        ).toMatchObject({ status: 200, text: "catalog page", truncated: false });

        const imageRequest = { operation: "generate", prompt: "a fox" } as const;
        expect(yield* run("GenerateImage", "image", imageRequest)).toEqual(imageResult);
        expect(generateImage).toHaveBeenCalledExactlyOnceWith(codexThreadId, imageRequest);

        expect(
          yield* run("SetMcpInstructions", "instructions", {
            serverId: "docs",
            instructions: " Search the docs first. ",
          }),
        ).toMatchObject({ serverId: "docs", instructions: "Search the docs first." });
        expect(dispatched).toEqual([
          expect.objectContaining({
            type: "mcp-server.instructions.set",
            mcpServerId: "docs",
            instructions: " Search the docs first. ",
          }),
        ]);

        const takeDispatched = () => dispatched.splice(0);
        takeDispatched();
        const anyCommandId = expect.stringMatching(/^catalog:/);

        expect(
          yield* run("AddMcpServer", "add-stdio", {
            serverId: "tools",
            name: "Tools",
            transport: "stdio",
            command: "uvx",
            args: ["tools-mcp", "--verbose"],
          }),
        ).toEqual({ serverId: "tools", added: true });
        expect(takeDispatched()).toEqual([
          {
            type: "mcp-server.create",
            commandId: anyCommandId,
            mcpServerId: "tools",
            name: "Tools",
            transport: "stdio",
            command: "uvx",
            args: ["tools-mcp", "--verbose"],
            enabled: true,
            createdAt: expect.any(String),
          },
        ]);

        expect(
          yield* run("AddMcpServer", "add-url", {
            serverId: "search",
            name: "Search",
            transport: "url",
            url: "https://mcp.example.com/search?region=eu",
          }),
        ).toEqual({ serverId: "search", added: true });
        expect(takeDispatched()).toEqual([
          {
            type: "mcp-server.create",
            commandId: anyCommandId,
            mcpServerId: "search",
            name: "Search",
            transport: "url",
            url: "https://mcp.example.com/search?region=eu",
            enabled: true,
            createdAt: expect.any(String),
          },
        ]);

        // A stdio add without a command fails schema validation before any dispatch.
        const invalidAdd = yield* Effect.promise(() =>
          runtime
            .execute({
              threadId: String(codexThreadId),
              toolId: "AddMcpServer",
              toolCallId: "add-invalid",
              input: { serverId: "broken", name: "Broken", transport: "stdio" },
              approvalMode: "require-grant",
            })
            .then(
              () => undefined,
              (error: unknown) => error,
            ),
        );
        expect(Schema.isSchemaError(invalidAdd)).toBe(true);
        expect(takeDispatched()).toEqual([]);

        expect(
          yield* run("RenameMcpAccount", "rename-url", { serverId: "docs", name: "Docs (EU)" }),
        ).toEqual({ serverId: "docs", name: "Docs (EU)", renamed: true });
        expect(
          yield* run("RenameMcpAccount", "rename-stdio", { serverId: "local", name: "Local 2" }),
        ).toEqual({ serverId: "local", name: "Local 2", renamed: true });
        expect(takeDispatched()).toEqual([
          {
            type: "mcp-server.update",
            commandId: anyCommandId,
            mcpServerId: "docs",
            name: "Docs (EU)",
            transport: "url",
            url: "https://mcp.example.com/docs",
          },
          {
            type: "mcp-server.update",
            commandId: anyCommandId,
            mcpServerId: "local",
            name: "Local 2",
            transport: "stdio",
            command: "npx",
            args: ["-y", "local-mcp"],
          },
        ]);

        expect(yield* run("UninstallMcpServer", "uninstall", { serverId: "docs" })).toEqual({
          serverId: "docs",
          removed: true,
          dependentBots: [{ id: "ada", name: "Ada" }],
          clearedDisabledFor: [{ id: "grace", name: "Grace" }],
        });
        expect(takeDispatched()).toEqual([
          { type: "mcp-server.delete", commandId: anyCommandId, mcpServerId: "docs" },
          {
            type: "bot.update",
            commandId: anyCommandId,
            botId: "grace",
            disabledMcpServerIds: ["other", "newer"],
          },
        ]);

        expect(yield* run("RemoveMcpAccount", "remove", { serverId: "local" })).toEqual({
          serverId: "local",
          removed: true,
          dependentBots: [
            { id: "ada", name: "Ada" },
            { id: "grace", name: "Grace" },
          ],
          clearedDisabledFor: [{ id: "linus", name: "Linus" }],
        });
        expect(takeDispatched()).toEqual([
          { type: "mcp-server.delete", commandId: anyCommandId, mcpServerId: "local" },
          { type: "bot.update", commandId: anyCommandId, botId: "linus", disabledMcpServerIds: [] },
        ]);
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => new Promise<void>((resolve) => page.close(() => resolve()))),
        ),
      ),
      bridge.service,
      mastra.factory,
      undefined,
      baseDir,
      undefined,
      {
        webFetch: {
          lookup: async () => [{ address: "127.0.0.1", family: 4 }],
          allowAddress: (address) => address === "127.0.0.1",
        },
        generateImage,
      },
      { imageGeneration: { chatgptEnabled: true } },
    );
  });

  it.effect("routes the Mastra GenerateImage catalog tool through the image runtime", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-catalog-image-"));
    const grokCalls: Array<unknown> = [];
    let grokGate: (() => void) | undefined;
    const grokAdapter: ImageProviderAdapter = {
      provider: "grok",
      capabilities: GROK_IMAGE_CAPABILITIES,
      run: (request, signal) => {
        grokCalls.push(request);
        if (!grokGate) {
          return Promise.resolve({
            images: [pngBytes(32, 32)],
            model: "grok-image-model",
          });
        }
        return new Promise((resolve, reject) => {
          grokGate!();
          signal.addEventListener("abort", () => {
            reject(signal.reason ?? new Error("aborted"));
          });
        });
      },
    };
    const {
      layer: runtimeLayer,
      dispatched,
      imageUsage,
    } = makeImageRuntimeTestLayer({
      baseDir,
      adapters: { chatgpt: grokAdapter, grok: grokAdapter },
      connected: ["xai"],
      settings: { grokEnabled: true },
      botProvider: "grok",
    });

    return provideController(
      Effect.gen(function* () {
        const imageRuntime = yield* ImageGenerationRuntime;
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).toContain(
          "GenerateImage",
        );
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).not.toContain(
          "generate_image",
        );
        const input = { operation: "generate", prompt: "a fox" } as const;
        const execution = {
          threadId: String(codexThreadId),
          toolId: "GenerateImage" as const,
          toolCallId: "image-catalog",
          input,
        };
        runtime.grantApproval(execution);
        const result = yield* Effect.promise(() =>
          Promise.resolve(runtime.execute({ ...execution, approvalMode: "require-grant" })),
        );
        expect(result).toMatchObject({ status: "completed", provider: "grok" });
        expect(grokCalls).toHaveLength(1);
        const delta = dispatched.find(
          (command) => command.type === "thread.message.assistant.delta",
        ) as { attachments?: unknown[] } | undefined;
        expect(delta?.attachments).toHaveLength(1);
        expect(
          dispatched.filter((command) => command.type === "thread.message.assistant.complete"),
        ).toHaveLength(1);
        expect(imageUsage).toHaveLength(1);

        // Interrupting the Mastra turn cancels an in-flight image request.
        const pending = yield* Effect.forkChild(imageRuntime.generate(codexThreadId, input));
        const gate = Deferred.makeUnsafe<string>();
        grokGate = () => Deferred.doneUnsafe(gate, Effect.succeed("release"));
        yield* Deferred.await(gate);
        expect(grokCalls).toHaveLength(2);
        yield* controller.interruptTurn({ threadId: codexThreadId });
        const cancelledExit = yield* Fiber.await(pending);
        expect(
          cancelledExit._tag === "Success" ? cancelledExit.value : cancelledExit,
        ).toMatchObject({ status: "failed", kind: "cancelled" });
      }).pipe(Effect.provide(runtimeLayer)),
      bridge.service,
      mastra.factory,
      undefined,
      baseDir,
      undefined,
      undefined,
      { imageGeneration: { grokEnabled: true } },
    );
  });

  it.effect("falls back to the next image provider when a Mastra image attempt times out", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const baseDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "akeru-catalog-image-timeout-"),
    );
    const requestTimeout = Duration.millis(50);
    const chatgptStarted = Deferred.makeUnsafe<void>();
    let chatgptAborted = false;
    const grokCalls: Array<unknown> = [];
    const chatgptAdapter: ImageProviderAdapter = {
      provider: "chatgpt",
      capabilities: GROK_IMAGE_CAPABILITIES,
      run: (_request, signal) =>
        new Promise((_resolve, reject) => {
          Deferred.doneUnsafe(chatgptStarted, Effect.void);
          signal.addEventListener("abort", () => {
            chatgptAborted = true;
            reject(signal.reason ?? new Error("aborted"));
          });
        }),
    };
    const grokAdapter: ImageProviderAdapter = {
      provider: "grok",
      capabilities: GROK_IMAGE_CAPABILITIES,
      run: (request) => {
        grokCalls.push(request);
        return Promise.resolve({ images: [pngBytes(32, 32)], model: "grok-image-model" });
      },
    };
    const settings = { chatgptEnabled: true, grokEnabled: true };
    const { layer: runtimeLayer, dispatched } = makeImageRuntimeTestLayer({
      baseDir,
      adapters: { chatgpt: chatgptAdapter, grok: grokAdapter },
      connected: ["openai-codex", "xai"],
      settings,
      botProvider: "chatgpt",
      requestTimeout,
    });

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
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        const execution = {
          threadId: String(codexThreadId),
          toolId: "GenerateImage" as const,
          toolCallId: "image-catalog-timeout",
          input: { operation: "generate", prompt: "a fox" },
        };
        runtime.grantApproval(execution);
        const pending = yield* Effect.forkChild(
          Effect.promise(() =>
            Promise.resolve(runtime.execute({ ...execution, approvalMode: "require-grant" })),
          ),
        );
        yield* Deferred.await(chatgptStarted);
        yield* TestClock.adjust(requestTimeout);
        const result = yield* Fiber.join(pending);

        expect(chatgptAborted).toBe(true);
        expect(grokCalls).toHaveLength(1);
        expect(result).toMatchObject({
          status: "completed",
          provider: "grok",
          attempts: [
            { provider: "chatgpt", outcome: "timeout" },
            { provider: "grok", outcome: "completed" },
          ],
        });
        expect(
          dispatched.filter((command) => command.type === "thread.message.assistant.complete"),
        ).toHaveLength(1);
      }).pipe(Effect.provide(runtimeLayer)),
      bridge.service,
      mastra.factory,
      undefined,
      baseDir,
      undefined,
      undefined,
      { imageGeneration: settings },
    );
  });

  it.effect("refuses an api-key openai-codex credential for ChatGPT images", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-image-apikey-"));
    const secretsDir = NodePath.join(baseDir, "userdata", "secrets");
    NodeFS.mkdirSync(secretsDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(secretsDir, "subscription-auth.json"),
      JSON.stringify({ "openai-codex": { type: "api-key", access: "openai-key" } }),
    );
    return Effect.gen(function* () {
      const subscriptionAuth = yield* Effect.promise(() =>
        makeTestSubscriptionAuthService(NodePath.join(secretsDir, "subscription-auth.json")),
      );
      const adapter = makeChatGptImageAdapter({ subscriptionAuth });
      const run = adapter.run(
        {
          operation: "generate",
          prompt: "a fox",
          inputImages: [],
          aspectRatio: undefined,
          quality: "standard",
          count: 1,
        },
        AbortSignal.timeout(5_000),
      );
      const failure = yield* Effect.promise(() =>
        run.then(
          () => {
            throw new Error("expected failure");
          },
          (cause: unknown) => cause,
        ),
      );
      expect(String((failure as Error).message)).toContain("ChatGPT account sign-in");
    }).pipe(Effect.provide(NodeServices.layer));
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

  it.effect("stops renewing a Mastra review claim once the turn settles", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-review-renewal-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-review-renewal");
    const renew = vi.spyOn(botMemoryStore, "renewReviewClaim");

    return provideController(
      Effect.gen(function* () {
        for (let prompt = 1; prompt <= 10; prompt += 1) {
          const reservation = yield* Effect.promise(() =>
            botMemoryStore.reserveReviewCadence(botId),
          );
          yield* Effect.promise(() => botMemoryStore.settleReviewCadence(reservation, true));
        }
        const settled = Promise.withResolvers<void>();
        const settleReviewClaim = botMemoryStore.settleReviewClaim.bind(botMemoryStore);
        vi.spyOn(botMemoryStore, "settleReviewClaim").mockImplementation(async (...args) => {
          const result = await settleReviewClaim(...args);
          settled.resolve();
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
          memoryAccess: {
            tenantId: AkeruMemoryTenantId.make("local"),
            userId: AkeruMemoryUserId.make("owner"),
            threadId: codexThreadId,
            projectId: ProjectId.make("project-review-renewal"),
            workspaceRoot: "/workspace/review-renewal",
            botId,
            groupId: null,
            respondingBotId: botId,
            groupMemberBotIds: [],
          },
        });
        // Effect's scheduler and the lock retry also use timers, so pump fake
        // time until the awaited receipt lands instead of advancing blindly.
        const pumpUntil = async (receipt: Promise<void>) => {
          let landed = false;
          void receipt.then(() => {
            landed = true;
          });
          while (!landed) await vi.advanceTimersByTimeAsync(15);
        };
        const secondRenewal = Promise.withResolvers<void>();
        renew.mockImplementation(async (...args) => {
          const result = await BotMemoryStore.prototype.renewReviewClaim.apply(
            botMemoryStore,
            args,
          );
          if (renew.mock.calls.length >= 2) secondRenewal.resolve();
          return result;
        });

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Review this turn." });
        yield* Effect.promise(() => pumpUntil(mastra.waitForSendMessageCount(1)));
        // While the turn runs, the claim is renewed on its 20 second schedule.
        yield* Effect.promise(() => pumpUntil(secondRenewal.promise));

        mastra.finishSend();
        yield* Effect.promise(() => pumpUntil(settled.promise));
        const renewalsBeforeSettlement = renew.mock.calls.length;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(120_000));
        expect(renew).toHaveBeenCalledTimes(renewalsBeforeSettlement);
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

  it.effect("honors the Memory setting per turn on the Mastra path", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "akeru-memory-toggle-mastra-"),
    );
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-memory-toggle-mastra");
    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: codexThreadId,
      projectId: ProjectId.make("project-memory-toggle-mastra"),
      workspaceRoot: "/workspace/memory-toggle-mastra",
      botId,
      groupId: null,
      respondingBotId: botId,
      groupMemberBotIds: [],
    } as const;

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const settings = yield* ServerSettingsService;
        yield* resolveCodex(controller);
        yield* Effect.promise(() =>
          botMemoryStore.mutate({
            ...access,
            target: "user",
            operations: [{ action: "add", content: "The user prefers vim." }],
          }),
        );
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          memoryAccess: access,
        });
        const reserve = vi.spyOn(botMemoryStore, "reserveReviewCadence");
        const readSnapshot = vi.spyOn(botMemoryStore, "readPromptSnapshot");

        // While Memory is on, the admitted turn supplies the durable snapshot.
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Remember this turn." });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
        expect(mastra.session.state.get().persistentMemoryContext).toContain("<user-memory>");
        mastra.finishSend();
        yield* Effect.yieldNow;

        const awaitNextCompletedTurn = () =>
          controller.streamEvents.pipe(
            Stream.filter((event) => event.type === "turn.completed"),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );

        // Toggling Memory off mid-session must stop snapshot reads and review
        // reservations for the very next turn, and remove the memory tool.
        yield* settings.updateSettings({ memory: { enabled: false } });
        const offTurn = yield* awaitNextCompletedTurn();
        yield* controller.sendTurn({ threadId: codexThreadId, input: "No memory now." });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(2));
        mastra.finishSend();
        yield* Fiber.join(offTurn);
        expect(readSnapshot).toHaveBeenCalledTimes(1);
        expect(reserve).toHaveBeenCalledTimes(1);
        expect(mastra.session.state.get()).not.toHaveProperty("persistentMemoryContext");
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        expect(runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id)).not.toContain(
          "memory",
        );

        // Turning Memory back on restores the snapshot on the next turn.
        yield* settings.updateSettings({ memory: { enabled: true } });
        const restoredTurn = yield* awaitNextCompletedTurn();
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Memory again." });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(3));
        expect(mastra.session.state.get().persistentMemoryContext).toContain("<user-memory>");
        mastra.finishSend();
        yield* Fiber.join(restoredTurn);
        expect(readSnapshot).toHaveBeenCalledTimes(2);
        expect(reserve).toHaveBeenCalledTimes(2);
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

  it.effect("reads entity memory for the access of a reused Mastra session", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-entity-reuse-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-entity-reuse");
    const accessFor = (project: string) =>
      ({
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: codexThreadId,
        projectId: ProjectId.make(project),
        workspaceRoot: "/workspace/entity-reuse",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      }) as const;
    const listedProjects: Array<string | null> = [];
    const listCurrent = vi.fn((input: { readonly access: { readonly projectId: unknown } }) => {
      listedProjects.push(String(input.access.projectId));
      return Effect.succeed([]);
    });
    const recordDerivedCopies = vi.fn(() => Effect.void);

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const start = (project: string) =>
          controller.startSession(codexThreadId, {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            memoryAccess: accessFor(project),
          });
        yield* start("project-before");
        yield* start("project-after");
        listedProjects.length = 0;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Use current memory." });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
        mastra.finishSend();
        yield* Effect.yieldNow;
        expect(listedProjects).toContain("project-after");
        expect(listedProjects).not.toContain("project-before");
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore, entityMemoryRepository: { listCurrent, recordDerivedCopies } as never },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
      ),
    );
  });

  it.effect("honors the Memory setting per turn on the legacy provider path", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "akeru-memory-toggle-legacy-"),
    );
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-memory-toggle-legacy");
    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: claudeThreadId,
      projectId: ProjectId.make("project-memory-toggle-legacy"),
      workspaceRoot: "/workspace/memory-toggle-legacy",
      botId,
      groupId: null,
      respondingBotId: botId,
      groupMemberBotIds: [],
    } as const;
    const credentials = makeMemoryOnlyCredentialOptions();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const settings = yield* ServerSettingsService;
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* Effect.promise(() =>
          botMemoryStore.mutate({
            ...access,
            target: "user",
            operations: [{ action: "add", content: "The user prefers vim." }],
          }),
        );
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: openCodeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          memoryAccess: access,
        });
        const reserve = vi.spyOn(botMemoryStore, "reserveReviewCadence");
        const readSnapshot = vi.spyOn(botMemoryStore, "readPromptSnapshot");

        yield* controller.sendTurn({ threadId: claudeThreadId, input: "First legacy turn." });
        expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
        expect(bridge.sendTurn.mock.calls[0]?.[0].persistentMemoryContext).toContain(
          "<user-memory>",
        );

        yield* settings.updateSettings({ memory: { enabled: false } });
        yield* controller.sendTurn({ threadId: claudeThreadId, input: "Memory off turn." });
        expect(bridge.sendTurn).toHaveBeenCalledTimes(2);
        expect(bridge.sendTurn.mock.calls[1]?.[0].persistentMemoryContext ?? "").not.toContain(
          "<user-memory>",
        );
        expect(reserve).toHaveBeenCalledTimes(1);
        expect(readSnapshot).toHaveBeenCalledTimes(1);

        yield* settings.updateSettings({ memory: { enabled: true } });
        yield* controller.sendTurn({ threadId: claudeThreadId, input: "Memory back on." });
        expect(bridge.sendTurn).toHaveBeenCalledTimes(3);
        expect(bridge.sendTurn.mock.calls[2]?.[0].persistentMemoryContext).toContain(
          "<user-memory>",
        );
        expect(reserve).toHaveBeenCalledTimes(2);
        expect(readSnapshot).toHaveBeenCalledTimes(2);
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore, ...credentials },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          McpMemoryToolSession.clearMcpMemoryToolSession(claudeThreadId);
          NodeFS.rmSync(memoryDir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("keeps entity memory out of a new legacy session while Memory is off", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const botId = BotId.make("bot-entity-memory-off");
    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: claudeThreadId,
      projectId: ProjectId.make("project-entity-memory-off"),
      workspaceRoot: "/workspace/entity-memory-off",
      botId,
      groupId: null,
      respondingBotId: botId,
      groupMemberBotIds: [],
    } as const;
    const listCurrent = vi.fn(() => Effect.succeed([]));
    // Only the entity packet records derived copies; the legacy migration read also lists facts.
    const recordDerivedCopies = vi.fn(() => Effect.void);

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({ memory: { enabled: false } });
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
          memoryAccess: access,
        });
        expect(recordDerivedCopies).not.toHaveBeenCalled();
        expect(bridge.startSession.mock.calls[0]?.[1].persistentMemoryContext).toBeUndefined();
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      {
        ...makeMemoryOnlyCredentialOptions(),
        entityMemoryRepository: { listCurrent, recordDerivedCopies } as never,
      },
    );
  });

  it.effect("keeps group facts out of memory when group membership cannot be rechecked", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const botId = BotId.make("bot-entity-memory-stale-group");
    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: claudeThreadId,
      projectId: ProjectId.make("project-entity-memory-stale-group"),
      workspaceRoot: "/workspace/entity-memory-stale-group",
      botId,
      groupId: GroupId.make("group-entity-memory-stale"),
      respondingBotId: botId,
      groupMemberBotIds: [botId],
    } as const;
    const listCurrent = vi.fn(
      (_input: { access: { groupId: GroupId | null; groupMemberBotIds: ReadonlyArray<BotId> } }) =>
        Effect.succeed([]),
    );
    const recordDerivedCopies = vi.fn(() => Effect.void);

    return provideController(
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
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          memoryAccess: access,
        });
        // Reads here are the legacy migration; no memory packet reaches the group prompt.
        expect(recordDerivedCopies).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      {
        ...makeMemoryOnlyCredentialOptions(),
        entityMemoryRepository: { listCurrent, recordDerivedCopies } as never,
      },
    );
  });

  it.effect("reads entity memory from the current project after reusing a legacy session", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const botId = BotId.make("bot-entity-memory-moved");
    const accessFor = (project: string) =>
      ({
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: claudeThreadId,
        projectId: ProjectId.make(project),
        workspaceRoot: "/workspace/entity-memory-moved",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      }) as const;
    const listCurrent = vi.fn((_input: { access: { projectId: ProjectId } }) => Effect.succeed([]));
    const startSession = (project: string) =>
      Effect.gen(function* () {
        const controller = yield* AgentController;
        return yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: openCodeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          memoryAccess: accessFor(project),
        });
      });

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* startSession("project-before-move");
        yield* startSession("project-after-move");
        expect(bridge.startSession).toHaveBeenCalledTimes(1);
        listCurrent.mockClear();

        yield* controller.sendTurn({ threadId: claudeThreadId, input: "After the move." });
        expect(listCurrent.mock.calls.map(([input]) => String(input.access.projectId))).toEqual([
          "project-after-move",
        ]);
      }),
      {
        ...bridge.service,
        listSessions: () => Effect.succeed([makeProviderSession(claudeThreadId, "opencode")]),
      },
      mastra.factory,
      undefined,
      undefined,
      undefined,
      {
        ...makeMemoryOnlyCredentialOptions(),
        entityMemoryRepository: { listCurrent, recordDerivedCopies: () => Effect.void } as never,
      },
    );
  });

  it.effect("grants legacy sessions the image tool when an image provider is enabled", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const credentials = makeMemoryOnlyCredentialOptions();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({ imageGeneration: { chatgptEnabled: true } });
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
        });
        expect(credentials.requests.at(-1)?.capabilities?.has("image")).toBe(true);
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      credentials,
    );
  });

  it.effect(
    "denies the legacy MCP memory tool while Memory is off and restores it on re-enable",
    () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const memoryDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "akeru-mcp-gate-legacy-"),
      );
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-mcp-gate-legacy");
      const access = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: claudeThreadId,
        projectId: ProjectId.make("project-mcp-gate-legacy"),
        workspaceRoot: "/workspace/mcp-gate-legacy",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      } as const;
      const credentials = makeMemoryOnlyCredentialOptions();
      const callMemoryTool = (input: { target: string; operations: Array<unknown> }) =>
        Effect.tryPromise({
          try: () => {
            const handler = McpMemoryToolSession.readMcpMemoryToolSession(claudeThreadId);
            assert.isDefined(handler);
            return handler({
              threadId: String(claudeThreadId),
              toolId: "memory",
              toolCallId: `mcp-memory-${NodeCrypto.randomUUID()}`,
              input,
              approvalMode: "require-grant",
            });
          },
          catch: (cause) =>
            new MemoryToolCallError({
              cause: cause instanceof Error ? cause : new Error(String(cause)),
            }),
        });

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const settings = yield* ServerSettingsService;
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
            memoryAccess: access,
          });

          const enabled = yield* callMemoryTool({
            target: "user",
            operations: [{ action: "add", content: "The user prefers vim." }],
          });
          expect(enabled).toMatchObject({ success: true, changed: true });

          // The handler stays registered between turns, so it must re-check the
          // Memory setting on every call.
          yield* settings.updateSettings({ memory: { enabled: false } });
          const denied = yield* callMemoryTool({
            target: "user",
            operations: [],
          }).pipe(Effect.result);
          assert.equal(denied._tag, "Failure");
          expect(denied._tag === "Failure" ? denied.failure.cause.message : "").toContain(
            "disabled",
          );
          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Memory off turn." });
          const deniedDuringTurn = yield* callMemoryTool({
            target: "user",
            operations: [],
          }).pipe(Effect.result);
          assert.equal(deniedDuringTurn._tag, "Failure");
          expect(
            deniedDuringTurn._tag === "Failure" ? deniedDuringTurn.failure.cause.message : "",
          ).toContain("disabled");

          yield* settings.updateSettings({ memory: { enabled: true } });
          const restored = yield* callMemoryTool({ target: "user", operations: [] });
          expect(restored).toMatchObject({
            success: true,
            content: "The user prefers vim.",
          });
        }),
        bridge.service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore, ...credentials },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            McpMemoryToolSession.clearMcpMemoryToolSession(claudeThreadId);
            NodeFS.rmSync(memoryDir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "withholds bot-private entity facts on the legacy path while Private bot memory is off",
    () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const botId = BotId.make("bot-entity-private-legacy");
      const projectId = ProjectId.make("project-entity-private-legacy");
      const access = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: claudeThreadId,
        projectId,
        workspaceRoot: "/workspace/entity-private-legacy",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      } as const;
      const revisions = privatePolicyRevisions(botId, projectId);
      const listCurrent = vi.fn(() => Effect.succeed(revisions));
      const recordDerivedCopies = vi.fn(
        (_input: { readonly revisions: ReadonlyArray<AkeruMemoryRevision> }) => Effect.void,
      );

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const settings = yield* ServerSettingsService;
          yield* settings.updateSettings({ memory: { privateBotMemory: false } });
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
            memoryAccess: access,
          });
          const startPacket = entityMemorySection(
            bridge.startSession.mock.calls[0]?.[1].persistentMemoryContext,
          );
          expect(startPacket).toContain("Shared project entity fact.");
          expect(startPacket).not.toContain("Bot-private entity fact.");
          expect(startPacket).not.toContain("Bot-about-you entity fact.");

          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Private off." });
          const offPacket = entityMemorySection(
            bridge.sendTurn.mock.calls[0]?.[0].persistentMemoryContext,
          );
          expect(offPacket).toContain("Shared project entity fact.");
          expect(offPacket).not.toContain("Bot-private entity fact.");
          expect(offPacket).not.toContain("Bot-about-you entity fact.");
          // Derived copies track only what reached the provider.
          for (const [input] of recordDerivedCopies.mock.calls) {
            expect(input.revisions.map((revision) => revision.partition.scope)).toEqual([
              "project",
            ]);
          }

          yield* settings.updateSettings({ memory: { privateBotMemory: true } });
          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Private on." });
          const onPacket = entityMemorySection(
            bridge.sendTurn.mock.calls[1]?.[0].persistentMemoryContext,
          );
          expect(onPacket).toContain("Bot-private entity fact.");
          expect(onPacket).toContain("Bot-about-you entity fact.");
        }),
        {
          ...bridge.service,
          listSessions: () => Effect.succeed([makeProviderSession(claudeThreadId, "opencode")]),
        },
        mastra.factory,
        undefined,
        undefined,
        undefined,
        {
          ...makeMemoryOnlyCredentialOptions(),
          entityMemoryRepository: { listCurrent, recordDerivedCopies } as never,
        },
      );
    },
  );

  it.effect(
    "withholds bot-private entity facts on the Mastra path while Private bot memory is off",
    () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-entity-private-"));
      const botMemoryStore = new BotMemoryStore(memoryDir);
      const botId = BotId.make("bot-entity-private-mastra");
      const projectId = ProjectId.make("project-entity-private-mastra");
      const access = {
        tenantId: AkeruMemoryTenantId.make("local"),
        userId: AkeruMemoryUserId.make("owner"),
        threadId: codexThreadId,
        projectId,
        workspaceRoot: "/workspace/entity-private-mastra",
        botId,
        groupId: null,
        respondingBotId: botId,
        groupMemberBotIds: [],
      } as const;
      const revisions = privatePolicyRevisions(botId, projectId);
      const listCurrent = vi.fn(() => Effect.succeed(revisions));
      const recordDerivedCopies = vi.fn(() => Effect.void);

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const settings = yield* ServerSettingsService;
          yield* resolveCodex(controller);
          yield* controller.startSession(codexThreadId, {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            memoryAccess: access,
          });
          const awaitNextCompletedTurn = () =>
            controller.streamEvents.pipe(
              Stream.filter((event) => event.type === "turn.completed"),
              Stream.runHead,
              Effect.forkChild({ startImmediately: true }),
            );

          yield* settings.updateSettings({ memory: { privateBotMemory: false } });
          const offTurn = yield* awaitNextCompletedTurn();
          yield* controller.sendTurn({ threadId: codexThreadId, input: "Private off." });
          yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
          const offPacket = entityMemorySection(mastra.session.state.get().persistentMemoryContext);
          expect(offPacket).toContain("Shared project entity fact.");
          expect(offPacket).not.toContain("Bot-private entity fact.");
          expect(offPacket).not.toContain("Bot-about-you entity fact.");
          mastra.finishSend();
          yield* Fiber.join(offTurn);

          yield* settings.updateSettings({ memory: { privateBotMemory: true } });
          yield* controller.sendTurn({ threadId: codexThreadId, input: "Private on." });
          yield* Effect.promise(() => mastra.waitForSendMessageCount(2));
          const onPacket = entityMemorySection(mastra.session.state.get().persistentMemoryContext);
          expect(onPacket).toContain("Bot-private entity fact.");
          expect(onPacket).toContain("Bot-about-you entity fact.");
          mastra.finishSend();
          yield* Effect.yieldNow;
        }),
        bridge.service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        { botMemoryStore, entityMemoryRepository: { listCurrent, recordDerivedCopies } as never },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(memoryDir, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect("applies the Private bot memory toggle mid-session on the legacy path", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-private-toggle-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-private-toggle-legacy");
    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: claudeThreadId,
      projectId: ProjectId.make("project-private-toggle-legacy"),
      workspaceRoot: "/workspace/private-toggle-legacy",
      botId,
      groupId: null,
      respondingBotId: botId,
      groupMemberBotIds: [],
    } as const;
    const credentials = makeMemoryOnlyCredentialOptions();
    const callMemoryTool = (input: {
      target: string;
      operations: Array<unknown>;
      share?: { fact: string; scope: string };
    }) =>
      Effect.tryPromise({
        try: () => {
          const handler = McpMemoryToolSession.readMcpMemoryToolSession(claudeThreadId);
          assert.isDefined(handler);
          return handler({
            threadId: String(claudeThreadId),
            toolId: "memory",
            toolCallId: `mcp-memory-${NodeCrypto.randomUUID()}`,
            input,
            approvalMode: "require-grant",
          });
        },
        catch: (cause) =>
          new MemoryToolCallError({
            cause: cause instanceof Error ? cause : new Error(String(cause)),
          }),
      });

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const settings = yield* ServerSettingsService;
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* Effect.promise(() =>
          botMemoryStore.mutate({
            ...access,
            target: "memory",
            operations: [{ action: "add", content: "Bot-private note." }],
          }),
        );
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: openCodeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          memoryAccess: access,
        });

        const privateRead = yield* callMemoryTool({ target: "memory", operations: [] });
        expect(privateRead).toMatchObject({ success: true, content: "Bot-private note." });

        // Turning Private bot memory off mid-session removes MEMORY.md from the
        // prompt and denies the bot-private target on the existing handler.
        yield* settings.updateSettings({ memory: { privateBotMemory: false } });
        yield* controller.sendTurn({ threadId: claudeThreadId, input: "Private off turn." });
        expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
        const context = bridge.sendTurn.mock.calls[0]?.[0].persistentMemoryContext ?? "";
        expect(context).not.toContain("<bot-memory>");
        expect(context).not.toContain("Bot-private note.");
        const denied = yield* callMemoryTool({ target: "memory", operations: [] }).pipe(
          Effect.result,
        );
        assert.equal(denied._tag, "Failure");
        expect(denied._tag === "Failure" ? denied.failure.cause.message : "").toContain(
          "Private bot memory is disabled.",
        );
        // A share-only call names the memory target but never touches MEMORY.md,
        // so it passes the Private bot memory gate and reaches the share path
        // (this fixture has no approvals service).
        const shareOnly = yield* callMemoryTool({
          target: "memory",
          operations: [],
          share: { fact: "The project uses pnpm.", scope: "project" },
        }).pipe(Effect.result);
        expect(shareOnly._tag === "Failure" ? shareOnly.failure.cause.message : "").toBe(
          "Shared memory is not available in this chat.",
        );
        const userStillAllowed = yield* callMemoryTool({ target: "user", operations: [] });
        expect(userStillAllowed).toMatchObject({ success: true });

        yield* settings.updateSettings({ memory: { privateBotMemory: true } });
        const restoredRead = yield* callMemoryTool({ target: "memory", operations: [] });
        expect(restoredRead).toMatchObject({ success: true, content: "Bot-private note." });
        yield* controller.sendTurn({ threadId: claudeThreadId, input: "Private on again." });
        expect(bridge.sendTurn.mock.calls[1]?.[0].persistentMemoryContext).toContain(
          "Bot-private note.",
        );
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore, ...credentials },
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          McpMemoryToolSession.clearMcpMemoryToolSession(claudeThreadId);
          NodeFS.rmSync(memoryDir, { recursive: true, force: true });
        }),
      ),
    );
  });

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
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
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

  it.effect(
    "hides the image tool on a reused Mastra session after image providers turn off",
    () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const settings = yield* ServerSettingsService;
          yield* resolveCodex(controller);
          const input = {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            modelSelection: codexSelection,
            runtimeMode: "full-access" as const,
          };
          yield* controller.startSession(codexThreadId, input);
          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);
          const toolIds = () =>
            runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id);
          expect(toolIds()).toContain("GenerateImage");

          yield* settings.updateSettings({ imageGeneration: { grokEnabled: false } });
          yield* controller.startSession(codexThreadId, input);
          expect(mastra.createSession).toHaveBeenCalledOnce();
          expect(toolIds()).not.toContain("GenerateImage");
        }),
        bridge.service,
        mastra.factory,
        undefined,
        undefined,
        undefined,
        undefined,
        { imageGeneration: { grokEnabled: true } },
      );
    },
  );

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

  it.effect("releases turn preparation when provider routing rejects a turn", () => {
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

        bridge.setInstanceEnabled(false);
        const rejected = yield* Effect.exit(
          controller.sendTurn({ threadId: openCodeGoThreadId, input: "Disabled" }),
        );
        assert.isTrue(Exit.isFailure(rejected));

        bridge.setInstanceEnabled(true);
        yield* controller.sendTurn({ threadId: openCodeGoThreadId, input: "Enabled again" });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
        mastra.finishSend();
        expect(mastra.sendMessage).toHaveBeenCalledWith({ content: "Enabled again" });
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

  it.effect("drops a Mastra admission interrupted while the memory settings read is held", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "akeru-mastra-admit-gate-"),
    );
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const botId = BotId.make("bot-mastra-admit-gate");
    const access = {
      tenantId: AkeruMemoryTenantId.make("local"),
      userId: AkeruMemoryUserId.make("owner"),
      threadId: codexThreadId,
      projectId: ProjectId.make("project-mastra-admit-gate"),
      workspaceRoot: "/workspace/mastra-admit-gate",
      botId,
      groupId: null,
      respondingBotId: botId,
      groupMemberBotIds: [],
    } as const;
    const disabledMemorySettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      memory: { ...DEFAULT_SERVER_SETTINGS.memory, enabled: false },
    };
    const sessionInput = {
      threadId: codexThreadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: codexInstanceId,
      modelSelection: codexSelection,
      runtimeMode: "full-access" as const,
      memoryAccess: access,
    };

    const gate = Deferred.makeUnsafe<void>();
    const reached = Deferred.makeUnsafe<void>();
    let holdNextGetSettings = false;
    const gatedSettingsLayer = Layer.succeed(ServerSettingsService, {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.suspend(() =>
        holdNextGetSettings
          ? Effect.sync(() => {
              Deferred.doneUnsafe(reached, Effect.void);
            }).pipe(Effect.andThen(Deferred.await(gate)), Effect.as(disabledMemorySettings))
          : Effect.succeed(disabledMemorySettings),
      ),
      updateSettings: () => Effect.die("not used"),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    });

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      yield* controller.startSession(codexThreadId, sessionInput);
      holdNextGetSettings = true;
      yield* controller.sendTurn({ threadId: codexThreadId, input: "Interrupt me." });
      yield* Deferred.await(reached);

      // Collect turn.started events for the rest of the test so we can prove
      // the cancelled admission never begins a turn.
      const startedEvents: TurnId[] = [];
      const startedFiber = yield* controller.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.started"),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.turnId) startedEvents.push(event.turnId);
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* controller.interruptTurn({ threadId: codexThreadId });
      const next = yield* controller.sendTurn({
        threadId: codexThreadId,
        input: "Replacement turn.",
      });
      // Admission of the replacement is queued behind the held settings read.
      assert.equal(mastra.sendMessage.mock.calls.length, 0);

      Deferred.doneUnsafe(gate, Effect.void);
      yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
      mastra.finishSend();
      yield* Effect.yieldNow;

      // The interrupted admission must never reach sendMessage or displace the
      // replacement turn's state.
      assert.equal(mastra.sendMessage.mock.calls.length, 1);
      expect(mastra.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Replacement turn."),
        }),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(startedFiber);
      assert.deepEqual(startedEvents, [next.turnId] as TurnId[]);
    }).pipe(
      Effect.provide(
        makeLayer(
          bridge.service,
          mastra.factory,
          undefined,
          undefined,
          undefined,
          { botMemoryStore },
          undefined,
          undefined,
          gatedSettingsLayer,
        ),
      ),
      Effect.orDie,
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(memoryDir, { recursive: true, force: true });
        }),
      ),
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

  it.effect("dispatches a thread activity when an observation is dropped", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const dispatched: Array<{
      readonly type: string;
      readonly commandId?: string;
      readonly activity?: unknown;
    }> = [];
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
        const options = mastra.harnessOptions[0]!;
        yield* Effect.promise(() =>
          Promise.resolve(
            options.onObservationDropped!({
              observationId: "observation-dropped-row",
              threadId: String(codexThreadId),
              turnId: "turn-dropped",
              resourceId: String(codexThreadId),
              modelId: "openai/gpt-5.6-sol",
              attempts: 3,
              error: new Error("observer down"),
            }),
          ),
        );
        assert.equal(dispatched.length, 1);
        const command = dispatched[0]!;
        assert.equal(command.type, "thread.activity.append");
        const activity = command.activity as {
          readonly kind: string;
          readonly tone: string;
          readonly turnId: string;
          readonly payload: { readonly attempts: number };
        };
        assert.equal(activity.kind, "memory.observation.dropped");
        assert.equal(activity.tone, "error");
        assert.equal(activity.turnId, "turn-dropped");
        assert.equal(activity.payload.attempts, 3);
        assert.equal(command.commandId, "server:observation-dropped:observation-dropped-row");
      }),
      bridge.service,
      mastra.factory,
    ).pipe(
      Effect.provideService(
        OrchestrationEngine.OrchestrationEngineService,
        OrchestrationEngine.OrchestrationEngineService.of({
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1 };
            }),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        }),
      ),
    );
  });

  it.effect("records memory usage for an observation drained before its chat reopens", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const usage = makeUsageLedger();
    const botId = BotId.make("bot-recovered-memory");
    return provideController(
      Effect.gen(function* () {
        // No startSession or turn: the durable queue drained after a restart.
        const options = mastra.harnessOptions[0]!;
        const callId = yield* Effect.promise(() =>
          options.startMemoryCall!({ threadId: "thread-recovered", category: "observer" }),
        );
        assert.isDefined(callId);
        yield* Effect.promise(() =>
          Promise.resolve(
            options.finishMemoryCall!({
              callId,
              category: "observer",
              usage: { inputTokens: 120, outputTokens: 30 },
            }),
          ),
        );
        expect(usage.reserve).not.toHaveBeenCalled();
        expect(usage.recordMeasurement).toHaveBeenCalledWith(
          expect.objectContaining({
            reservationId: callId,
            botId,
            threadId: ThreadId.make("thread-recovered"),
            category: "observer",
            inputTokens: 120,
            outputTokens: 30,
          }),
        );
      }),
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      usage.service,
    ).pipe(
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
          getThreadRuntimeContext: () => Effect.succeed(Option.some({ botId })),
          getBotById: () => Effect.succeed(Option.none()),
          getGroupById: () => Effect.succeed(Option.none()),
          listThreadDelegations: () => Effect.succeed([]),
        } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      ),
    );
  });

  for (const action of ["replace", "interrupt", "stop"] as const) {
    it.effect(`does not enqueue an attachment turn after session ${action}`, () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();

      return Effect.gen(function* () {
        let markReadStarted!: () => void;
        const readStarted = new Promise<void>((resolve) => {
          markReadStarted = resolve;
        });
        let releaseRead!: (bytes: Uint8Array) => void;
        const blockedRead = new Promise<Uint8Array>((resolve) => {
          releaseRead = resolve;
        });
        const layer = makeLayer(bridge.service, mastra.factory, undefined, undefined, undefined, {
          readAttachment: () => {
            markReadStarted();
            return blockedRead;
          },
        });
        const program = Effect.gen(function* () {
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
          const sending = yield* controller
            .sendTurn({
              threadId: codexThreadId,
              input: "Inspect this image.",
              attachments: [
                {
                  type: "image",
                  id: "image-1",
                  name: "screenshot.png",
                  mimeType: "image/png",
                  sizeBytes: 4,
                },
              ],
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => readStarted);
          expect(yield* controller.listSessions()).toHaveLength(1);

          if (action === "replace") {
            yield* controller.startSession(codexThreadId, {
              threadId: codexThreadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: codexInstanceId,
              cwd: NodeOS.tmpdir(),
              modelSelection: codexSelection,
              runtimeMode: "full-access",
            });
          } else if (action === "interrupt") {
            yield* controller.interruptTurn({ threadId: codexThreadId });
          } else {
            yield* controller.stopSession({ threadId: codexThreadId });
          }
          releaseRead(new Uint8Array([0, 1, 2, 3]));

          const exit = yield* Fiber.await(sending);
          assert.isTrue(Exit.isFailure(exit));
          expect(mastra.sendMessage).not.toHaveBeenCalled();
        });
        yield* program.pipe(Effect.provide(layer));
      }).pipe(Effect.orDie);
    });
  }

  it.effect("dispatches the drop activity without an active session", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const dispatched: Array<{ readonly type: string; readonly activity?: unknown }> = [];
    return provideController(
      Effect.gen(function* () {
        // No startSession: the durable queue can drain after a restart before
        // any client opens the thread, so the drop must still be appended.
        const options = mastra.harnessOptions[0]!;
        yield* Effect.promise(() =>
          Promise.resolve(
            options.onObservationDropped!({
              observationId: "observation-never-opened",
              threadId: "thread-never-opened",
              turnId: "turn-durable",
              resourceId: "thread-never-opened",
              modelId: "openai/gpt-5.6-sol",
              attempts: 3,
              error: new Error("observer down"),
            }),
          ),
        );
        assert.equal(dispatched.length, 1);
        const command = dispatched[0]!;
        assert.equal(command.type, "thread.activity.append");
        const activity = command.activity as {
          readonly kind: string;
          readonly turnId: string;
        };
        assert.equal(activity.kind, "memory.observation.dropped");
        assert.equal(activity.turnId, "turn-durable");
      }),
      bridge.service,
      mastra.factory,
    ).pipe(
      Effect.provideService(
        OrchestrationEngine.OrchestrationEngineService,
        OrchestrationEngine.OrchestrationEngineService.of({
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1 };
            }),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        }),
      ),
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
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Check the project.",
          hiddenWake: true,
        });
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
        expect(events.find((event) => event.type === "turn.started")?.payload.hiddenWake).toBe(
          true,
        );

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

  describe("routine review", () => {
    const routineInput = {
      name: "Morning summary",
      instructions: "Summarize overnight changes.",
      schedule: { kind: "daily", time: "09:00" },
    } as const;

    // Opens a routine review on a running Codex turn and returns the pending tool call.
    const openRoutineReview = (
      mastra: ReturnType<typeof makeMastraHarness>,
      events: Array<ProviderRuntimeEvent>,
    ) =>
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
        const opened = yield* Deferred.make<string>();
        const nextOpened = yield* Deferred.make<string>();
        let openedCount = 0;
        yield* controller.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
              if (event.type === "request.opened" && event.requestId) {
                Deferred.doneUnsafe(
                  openedCount++ === 0 ? opened : nextOpened,
                  Exit.succeed(String(event.requestId)),
                );
              }
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "Make a routine.",
          timezone: "UTC",
        });
        const createRoutine = mastra.harnessOptions[0]?.createRoutine;
        assert.isDefined(createRoutine);
        const toolCall = yield* Effect.promise(() =>
          createRoutine(String(codexThreadId), routineInput).then(
            (value) => Exit.succeed(value),
            (cause: unknown) => Exit.fail(cause),
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        const requestId = yield* Deferred.await(opened);
        return { controller, toolCall, requestId, nextOpened };
      });

    const provideRoutineController = <A, E>(
      effect: Effect.Effect<A, E, AgentController | ServerSettingsService>,
      mastra: ReturnType<typeof makeMastraHarness>,
      dispatcher: Partial<RoutineDraftDispatcherShape>,
    ) =>
      effect.pipe(
        Effect.provide(
          makeLayer(makeBridge().service, mastra.factory).pipe(
            Layer.provide(Layer.mock(RoutineDraftDispatcher)(dispatcher)),
          ),
        ),
        Effect.orDie,
      );

    it.effect("creates the routine when the answer lands before the limit", () => {
      const mastra = makeMastraHarness();
      const events: Array<ProviderRuntimeEvent> = [];
      const created = {
        routineId: RoutineId.make("routine-created"),
        sequence: 1,
        status: "approved" as const,
      };
      let dispatched = 0;
      return provideRoutineController(
        Effect.gen(function* () {
          const { controller, toolCall, requestId } = yield* openRoutineReview(mastra, events);
          yield* TestClock.adjust(60 * 60_000 - 1_000);
          // Creation is slow enough to cross the one-hour review limit.
          const answer = yield* controller
            .respondToRequest({
              threadId: codexThreadId,
              requestId: ApprovalRequestId.make(requestId),
              decision: "accept",
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust(5 * 60_000);
          yield* Fiber.join(answer);
          const result = yield* Fiber.join(toolCall);
          assert.deepStrictEqual(result, Exit.succeed(created));
          assert.strictEqual(dispatched, 1);
          const resolved = events.filter((event) => event.type === "request.resolved");
          assert.deepStrictEqual(
            resolved.map((event) => event.payload),
            [{ requestType: "dynamic_tool_call", decision: "accept" }],
          );
          mastra.finishSend();
        }),
        mastra,
        {
          createApprovedForThread: () =>
            Effect.sync(() => dispatched++).pipe(
              Effect.andThen(Effect.sleep("2 minutes")),
              Effect.as(created),
            ),
        },
      );
    });

    it.effect("keeps an accepted review waiting until its routine is created", () => {
      const mastra = makeMastraHarness();
      const events: Array<ProviderRuntimeEvent> = [];
      const lastState = () =>
        events.findLast((event) => event.type === "session.state.changed")?.payload.state;
      return provideRoutineController(
        Effect.gen(function* () {
          const { controller, toolCall, requestId } = yield* openRoutineReview(mastra, events);
          const answer = yield* controller
            .respondToRequest({
              threadId: codexThreadId,
              requestId: ApprovalRequestId.make(requestId),
              decision: "accept",
            })
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;
          assert.isFalse(events.some((event) => event.type === "request.resolved"));
          assert.strictEqual(lastState(), "waiting");

          yield* TestClock.adjust("2 minutes");
          assert.instanceOf(yield* Fiber.join(answer), AgentControllerRuntimeError);
          assert.isTrue(Exit.isFailure(yield* Fiber.join(toolCall)));
          assert.deepStrictEqual(
            events.filter((event) => event.type === "request.resolved").map((e) => e.payload),
            [{ requestType: "dynamic_tool_call", decision: "accept", outcome: "failed" }],
          );
          assert.strictEqual(lastState(), "running");
          mastra.finishSend();
        }),
        mastra,
        {
          createApprovedForThread: () =>
            Effect.sleep("2 minutes").pipe(
              Effect.andThen(
                Effect.fail(new RoutineDraftError({ message: "The routine could not be saved." })),
              ),
            ),
        },
      );
    });

    it.effect("keeps the turn waiting on a routine review after a tool approval answer", () => {
      const mastra = makeMastraHarness();
      const events: Array<ProviderRuntimeEvent> = [];
      return provideRoutineController(
        Effect.gen(function* () {
          const { controller, toolCall, requestId } = yield* openRoutineReview(mastra, events);
          mastra.emit({
            type: "tool_approval_required",
            toolCallId: "restart-tool-1",
            toolName: "RestartMcpServers",
            args: {},
          } as AgentControllerEvent);
          yield* Effect.yieldNow;
          yield* controller.respondToRequest({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make("restart-tool-1"),
            decision: "accept",
          });
          yield* Effect.yieldNow;
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "request.resolved" && String(event.requestId) === "restart-tool-1",
            ),
          );
          assert.strictEqual(
            events.findLast((event) => event.type === "session.state.changed")?.payload.state,
            "waiting",
          );
          yield* controller.respondToRequest({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make(requestId),
            decision: "decline",
          });
          assert.deepStrictEqual(
            yield* Fiber.join(toolCall),
            Exit.succeed({ status: "cancelled" }),
          );
          mastra.finishSend();
        }),
        mastra,
        {},
      );
    });

    it.effect("closes an unanswered review as a system cancellation", () => {
      const mastra = makeMastraHarness();
      const events: Array<ProviderRuntimeEvent> = [];
      let dispatched = 0;
      return provideRoutineController(
        Effect.gen(function* () {
          const { controller, toolCall, requestId } = yield* openRoutineReview(mastra, events);
          yield* TestClock.adjust(60 * 60_000);
          const result = yield* Fiber.join(toolCall);
          assert.isTrue(Exit.isFailure(result));
          const resolved = events.filter((event) => event.type === "request.resolved");
          assert.deepStrictEqual(
            resolved.map((event) => event.payload),
            [
              {
                requestType: "dynamic_tool_call",
                decision: "cancel",
                actor: "system",
                target: AKERU_CREATE_ROUTINE_TOOL_NAME,
                outcome: "cancelled",
              },
            ],
          );
          const late = yield* controller
            .respondToRequest({
              threadId: codexThreadId,
              requestId: ApprovalRequestId.make(requestId),
              decision: "accept",
            })
            .pipe(Effect.flip);
          assert.instanceOf(late, AgentControllerRuntimeError);
          assert.strictEqual(dispatched, 0);
          mastra.finishSend();
        }),
        mastra,
        {
          createApprovedForThread: () =>
            Effect.sync(() => dispatched++).pipe(
              Effect.as({
                routineId: RoutineId.make("routine-late"),
                sequence: 1,
                status: "approved" as const,
              }),
            ),
        },
      );
    });

    it.effect("keeps the turn waiting when another routine review remains open", () => {
      const mastra = makeMastraHarness();
      const events: Array<ProviderRuntimeEvent> = [];
      return provideRoutineController(
        Effect.gen(function* () {
          const {
            controller,
            toolCall: firstCall,
            nextOpened,
          } = yield* openRoutineReview(mastra, events);
          yield* TestClock.adjust(30 * 60_000);
          const createRoutine = mastra.harnessOptions[0]?.createRoutine;
          assert.isDefined(createRoutine);
          const secondCall = yield* Effect.promise(() =>
            createRoutine(String(codexThreadId), routineInput).then(
              (value) => Exit.succeed(value),
              (cause: unknown) => Exit.fail(cause),
            ),
          ).pipe(Effect.forkChild({ startImmediately: true }));
          const secondRequestId = yield* Deferred.await(nextOpened);

          yield* TestClock.adjust(30 * 60_000);
          assert.isTrue(Exit.isFailure(yield* Fiber.join(firstCall)));
          mastra.finishSend();
          yield* controller.respondToRequest({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make(secondRequestId),
            decision: "decline",
          });
          assert.deepStrictEqual(
            yield* Fiber.join(secondCall),
            Exit.succeed({ status: "cancelled" }),
          );
        }),
        mastra,
        {},
      );
    });

    it.effect("rejects a routine answer from another active chat without claiming it", () => {
      const mastra = makeMastraHarness();
      const events: Array<ProviderRuntimeEvent> = [];
      return provideRoutineController(
        Effect.gen(function* () {
          const { controller, toolCall, requestId } = yield* openRoutineReview(mastra, events);
          yield* controller.resolveEngine({
            threadId: claudeThreadId,
            engine: { provider: "codex", model: "gpt-5.6-sol" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(claudeThreadId, {
            threadId: claudeThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            modelSelection: codexSelection,
            runtimeMode: "full-access",
          });
          yield* controller.sendTurn({ threadId: claudeThreadId, input: "Another chat." });

          const wrongChat = yield* controller
            .respondToRequest({
              threadId: claudeThreadId,
              requestId: ApprovalRequestId.make(requestId),
              decision: "accept",
            })
            .pipe(Effect.flip);
          assert.instanceOf(wrongChat, AgentControllerRuntimeError);
          assert.strictEqual(events.filter((event) => event.type === "request.resolved").length, 0);

          yield* controller.respondToRequest({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make(requestId),
            decision: "decline",
          });
          assert.deepStrictEqual(
            yield* Fiber.join(toolCall),
            Exit.succeed({ status: "cancelled" }),
          );
          mastra.finishSend();
        }),
        mastra,
        {},
      );
    });
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
    const usageLedger = makeUsageLedger();
    usageLedger.reserve.mockImplementation(() => Effect.die("usage reserve failed"));
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
      usageLedger.service,
    ).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
    );
  });

  it.effect("offers Enable Auto Review for workspace commands and then stops asking", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const events: ProviderRuntimeEvent[] = [];
        yield* controller.streamEvents.pipe(
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
        yield* controller.sendTurn({ threadId: codexThreadId, input: "List files." });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shell-review-1",
          toolName: "Shell",
          args: { command: "sleep 5; ls -la" },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;

        const opened = events.find(
          (event): event is Extract<ProviderRuntimeEvent, { readonly type: "request.opened" }> =>
            event.type === "request.opened" && event.requestId === "shell-review-1",
        );
        expect(opened?.payload.options?.map((option) => option.decision)).toEqual([
          "decline",
          "acceptAlways",
          "accept",
        ]);

        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("shell-review-1"),
          decision: "acceptAlways",
        });
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shell-review-2",
          toolName: "Shell",
          args: { command: "ls" },
        } as AgentControllerEvent);
        yield* Effect.yieldNow;

        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "shell-review-2",
          decision: "approve",
        });
        expect(
          events.some(
            (event) => event.type === "request.opened" && event.requestId === "shell-review-2",
          ),
        ).toBe(false);
        // The auto-approved call must also pass the runtime's own grant check.
        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);
        yield* Effect.promise(() =>
          runtime.execute({
            threadId: String(codexThreadId),
            toolId: "Shell",
            toolCallId: "shell-review-2",
            input: { command: "ls" },
            approvalMode: "require-grant",
          }),
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
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
          runtimeMode: "approval-required",
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
          runtimeMode: "approval-required",
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
          toolName: "gmail_send_message",
          args: { to: "user@example.com" },
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

  describe("temporary workers", () => {
    const bossBotId = BotId.make("bot-boss");
    const linearServer: McpServer = {
      id: McpServerId.make("linear"),
      name: "Linear",
      transport: "url",
      url: "https://mcp.example.com/linear",
      enabled: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const groupParentSnapshot = {
      threads: [
        {
          id: codexThreadId,
          projectId: ProjectId.make("project-workers"),
          botId: null,
          groupId: GroupId.make("group-workers"),
          respondingBotId: bossBotId,
          runtimeMode: "approval-required",
          modelSelection: codexSelection,
          branch: null,
          worktreePath: null,
        },
      ],
      bots: [],
      groups: [],
      delegations: [],
    } as unknown as OrchestrationReadModel;

    /** A second fake Mastra session, so events reach only the worker thread. */
    const makeWorkerSession = (base: Session<Record<string, unknown>>) => {
      const listeners = new Set<(event: AgentControllerEvent) => void>();
      const session = {
        ...base,
        subscribe: vi.fn((listener: (event: AgentControllerEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        sendMessage: vi.fn(() => new Promise<void>(() => undefined)),
        respondToToolApproval: vi.fn(),
      } as unknown as Session<Record<string, unknown>>;
      return {
        session,
        emit: (event: AgentControllerEvent) => {
          for (const listener of listeners) listener(event);
        },
      };
    };

    it.effect("runs a Task from a group chat as a direct, locked-down worker", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const worker = makeWorkerSession(mastra.session);
      const mcpManager = {
        init: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        getTools: vi.fn(() => ({ linear_update: { mcp: { annotations: {} } } })),
        getServerStatuses: vi.fn(() => []),
      };
      const dispatched: OrchestrationCommand[] = [];
      const turnStarted = Promise.withResolvers<void>();
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* controller.configureDelegation!({
            readSnapshot: async () => groupParentSnapshot,
            dispatch: async (command) => {
              dispatched.push(command);
              if (command.type === "thread.turn.start") turnStarted.resolve();
              return { sequence: dispatched.length };
            },
          });
          yield* resolveCodex(controller);
          const sessionInput = {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            cwd: process.cwd(),
            modelSelection: codexSelection,
            runtimeMode: "approval-required" as const,
            botId: bossBotId,
            botName: "Boss",
            mcpServers: [linearServer],
          };
          yield* controller.startSession(codexThreadId, {
            ...sessionInput,
            threadId: codexThreadId,
          });
          yield* controller.sendTurn({ threadId: codexThreadId, input: "Split this up." });

          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);
          const parentTools = runtime.toolsForThread(String(codexThreadId)).map((tool) => tool.id);
          expect(parentTools).toEqual(expect.arrayContaining(["Task", "ExternalShell"]));

          const spawned = (yield* Effect.promise(() =>
            runtime.execute({
              threadId: String(codexThreadId),
              toolId: "Task",
              toolCallId: "task-1",
              input: { task: "Update the Linear issue", background: true },
              approvalMode: "require-grant",
            }),
          )) as { readonly phase: { readonly _tag: string } };
          expect(spawned.phase._tag).toBe("Running");
          yield* Effect.promise(() => turnStarted.promise);
          const [create, start] = dispatched;
          expect(create).toMatchObject({
            type: "thread.create",
            botId: bossBotId,
            groupId: null,
            parentThreadId: codexThreadId,
          });
          const childThreadId = (create as { readonly threadId: ThreadId }).threadId;
          expect(start).toMatchObject({ type: "thread.turn.start", threadId: childThreadId });
          expect(start).not.toHaveProperty("respondingBotId");

          // The turn-start reactor would start the worker session like this.
          mastra.createSession.mockImplementationOnce(async () => worker.session as never);
          yield* controller.resolveEngine({
            threadId: childThreadId,
            engine: null,
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(childThreadId, {
            ...sessionInput,
            threadId: childThreadId,
          });
          const workerTools = runtime.toolsForThread(String(childThreadId)).map((tool) => tool.id);
          for (const toolId of [
            "Task",
            "request_box_help",
            "ReactToMessage",
            "ExternalShell",
            "AwaitExternalShell",
          ]) {
            expect(workerTools).not.toContain(toolId);
          }

          const events: ProviderRuntimeEvent[] = [];
          const eventsFiber = yield* controller.streamEvents.pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Effect.yieldNow;
          yield* controller.sendTurn({ threadId: childThreadId, input: "Update the issue." });
          worker.emit({
            type: "tool_approval_required",
            toolCallId: "worker-linear",
            toolName: "linear_update",
            args: { issue: "LEO-1", state: "done" },
          } as AgentControllerEvent);
          yield* Effect.yieldNow;

          expect(worker.session.respondToToolApproval).toHaveBeenCalledWith({
            toolCallId: "worker-linear",
            decision: "decline",
            declineContext: expect.objectContaining({
              message: expect.stringContaining("linear_update"),
            }),
          });
          expect(mastra.session.respondToToolApproval).not.toHaveBeenCalled();
          expect(events.filter((event) => event.type === "request.opened")).toEqual([]);
          yield* Fiber.interrupt(eventsFiber);
        }),
        bridge.service,
        mastra.factory,
        () => mcpManager as never,
      );
    });

    it.effect("keeps worker limits and declines approvals in a worker chat after a restart", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const mcpManager = {
        init: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        getTools: vi.fn(() => ({ linear_update: { mcp: { annotations: {} } } })),
        getServerStatuses: vi.fn(() => []),
      };
      // The worker runtime has no record of this chat, as after a server restart.
      const orphanThreadId = ThreadId.make("worker-thread-orphaned");
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* controller.configureDelegation!({
            readSnapshot: async () => groupParentSnapshot,
            dispatch: async () => ({ sequence: 1 }),
          });
          yield* controller.resolveEngine({
            threadId: orphanThreadId,
            engine: null,
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(orphanThreadId, {
            threadId: orphanThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            cwd: process.cwd(),
            modelSelection: codexSelection,
            runtimeMode: "approval-required",
            botId: bossBotId,
            botName: "Boss",
            mcpServers: [linearServer],
          });
          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);
          const tools = runtime.toolsForThread(String(orphanThreadId)).map((tool) => tool.id);
          // Without a parent link to rebuild the grant from, the chat keeps no tools.
          for (const toolId of [
            "Read",
            "Task",
            "request_box_help",
            "ReactToMessage",
            "ExternalShell",
          ]) {
            expect(tools).not.toContain(toolId);
          }

          yield* controller.sendTurn({ threadId: orphanThreadId, input: "Update the issue." });
          mastra.emit({
            type: "tool_approval_required",
            toolCallId: "orphan-linear",
            toolName: "linear_update",
            args: { issue: "LEO-1", state: "done" },
          } as AgentControllerEvent);
          yield* Effect.yieldNow;

          expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
            toolCallId: "orphan-linear",
            decision: "decline",
            declineContext: expect.objectContaining({
              message: expect.stringContaining("linear_update"),
            }),
          });
        }),
        bridge.service,
        mastra.factory,
        () => mcpManager as never,
      );
    });

    it.effect("rebuilds an orphaned worker grant from its delegated parent after a restart", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const mcpManager = {
        init: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        getTools: vi.fn(() => ({ linear_update: { mcp: { annotations: {} } } })),
        getServerStatuses: vi.fn(() => []),
      };
      // The worker's parent is a delegated chat limited to Task and WebSearch.
      const delegatedParentThreadId = ThreadId.make("thread-delegated-parent");
      const orphanThreadId = ThreadId.make("worker-thread-restricted");
      const parentDelegation = {
        delegationId: "delegation-restricted",
        parentThreadId: codexThreadId,
        phase: {
          _tag: "Completed",
          childThreadId: delegatedParentThreadId,
          childTurnId: null,
          startedAt: "2026-09-01T00:00:00.000Z",
          completedAt: "2026-09-01T00:01:00.000Z",
          result: { summary: "Done.", childThreadId: delegatedParentThreadId },
          acknowledgedAt: null,
        },
        access: {
          allowedToolIds: ["Task", "WebSearch"],
          memoryScopes: [],
          sandbox: null,
          runtimeMode: "approval-required",
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "none",
        },
      };
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* controller.configureDelegation!({
            readSnapshot: async () => groupParentSnapshot,
            dispatch: async () => ({ sequence: 1 }),
          });
          yield* controller.resolveEngine({
            threadId: orphanThreadId,
            engine: null,
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          yield* controller.startSession(orphanThreadId, {
            threadId: orphanThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            cwd: process.cwd(),
            modelSelection: codexSelection,
            runtimeMode: "approval-required",
            botId: bossBotId,
            botName: "Boss",
            mcpServers: [linearServer],
          });
          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);
          const tools = runtime.toolsForThread(String(orphanThreadId)).map((tool) => tool.id);
          expect(tools).toContain("WebSearch");
          for (const toolId of ["Read", "Task", "linear_update"]) {
            expect(tools).not.toContain(toolId);
          }
        }),
        bridge.service,
        mastra.factory,
        () => mcpManager as never,
      ).pipe(
        Effect.provideService(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
            getThreadRuntimeContext: (threadId: ThreadId) =>
              Effect.succeed(
                Option.some(
                  threadId === orphanThreadId
                    ? { botId: bossBotId, parentThreadId: delegatedParentThreadId }
                    : { botId: bossBotId },
                ),
              ),
            getBotById: () => Effect.succeed(Option.none()),
            getGroupById: () => Effect.succeed(Option.none()),
            listThreadDelegations: (threadId: ThreadId) =>
              Effect.succeed(threadId === delegatedParentThreadId ? [parentDelegation] : []),
          } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
        ),
      );
    });

    it.effect("removes the hidden worker chat when its first turn is rejected", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const dispatched: OrchestrationCommand[] = [];
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* controller.configureDelegation!({
            readSnapshot: async () => groupParentSnapshot,
            dispatch: async (command) => {
              dispatched.push(command);
              if (command.type === "thread.turn.start") {
                throw new Error("A person member must send turns to this group.");
              }
              return { sequence: dispatched.length };
            },
          });
          yield* resolveCodex(controller);
          yield* controller.startSession(codexThreadId, {
            threadId: codexThreadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: codexInstanceId,
            cwd: process.cwd(),
            modelSelection: codexSelection,
            runtimeMode: "approval-required",
            botId: bossBotId,
            botName: "Boss",
          });
          yield* controller.sendTurn({ threadId: codexThreadId, input: "Split this up." });

          const runtime = mastra.harnessOptions[0]?.toolRuntime;
          assert.isDefined(runtime);
          const status = (yield* Effect.promise(() =>
            runtime.execute({
              threadId: String(codexThreadId),
              toolId: "Task",
              toolCallId: "task-rejected",
              input: { task: "Never starts" },
              approvalMode: "require-grant",
            }),
          )) as { readonly phase: { readonly _tag: string; readonly failureCode?: string } };
          expect(status.phase).toMatchObject({ _tag: "Failed", failureCode: "internal" });
          // Foreground Task settles only after the discard ran.
          const [create, start, discard] = dispatched;
          expect(create).toMatchObject({ type: "thread.create" });
          expect(start).toMatchObject({ type: "thread.turn.start" });
          expect(discard).toMatchObject({
            type: "thread.delete",
            threadId: (create as { readonly threadId: ThreadId }).threadId,
          });
        }),
        bridge.service,
        mastra.factory,
      );
    });
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

  it.effect("keeps a turn waiting while another suspended question is open", () => {
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
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Ask two questions." });
        for (const toolCallId of ["question-a", "question-b"]) {
          mastra.emit({
            type: "tool_suspended",
            toolCallId,
            toolName: "ask_user",
            args: {},
            suspendPayload: {},
          } as AgentControllerEvent);
        }
        mastra.emit({ type: "agent_end", reason: "suspended" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;
        const latestState = () =>
          events.findLast((event) => event.type === "session.state.changed")?.payload.state;

        yield* controller.respondToUserInput({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("question-a"),
          answers: { "question-a": "First" },
        });
        yield* Effect.yieldNow;
        expect(latestState()).toBe("waiting");

        yield* controller.respondToUserInput({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("question-b"),
          answers: { "question-b": "Second" },
        });
        yield* Effect.yieldNow;
        expect(latestState()).toBe("running");
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("keeps a question open when resuming its answer fails", () => {
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
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Ask two questions." });
        for (const toolCallId of ["question-a", "question-b"]) {
          mastra.emit({
            type: "tool_suspended",
            toolCallId,
            toolName: "ask_user",
            args: {},
            suspendPayload: {},
          } as AgentControllerEvent);
        }
        mastra.emit({ type: "agent_end", reason: "suspended" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;
        const latestState = () =>
          events.findLast((event) => event.type === "session.state.changed")?.payload.state;

        vi.mocked(mastra.session.respondToToolSuspension).mockRejectedValueOnce(
          new Error("connection lost"),
        );
        const failedExit = yield* controller
          .respondToUserInput({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make("question-a"),
            answers: { "question-a": "First" },
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(failedExit));
        expect(failedExit).toMatchObject({
          cause: { reasons: [{ error: { retryable: true } }] },
        });

        yield* controller.respondToUserInput({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("question-b"),
          answers: { "question-b": "Second" },
        });
        yield* Effect.yieldNow;
        expect(latestState()).toBe("waiting");
        yield* Fiber.interrupt(collector);
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("does not strand the turn on a failed answer to an unknown question", () => {
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
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Ask two questions." });
        for (const toolCallId of ["question-b"]) {
          mastra.emit({
            type: "tool_suspended",
            toolCallId,
            toolName: "ask_user",
            args: {},
            suspendPayload: {},
          } as AgentControllerEvent);
        }
        mastra.emit({ type: "agent_end", reason: "suspended" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;
        const latestState = () =>
          events.findLast((event) => event.type === "session.state.changed")?.payload.state;

        vi.mocked(mastra.session.respondToToolSuspension).mockRejectedValueOnce(
          new Error("connection lost"),
        );
        const failedExit = yield* controller
          .respondToUserInput({
            threadId: codexThreadId,
            requestId: ApprovalRequestId.make("question-stale"),
            answers: { "question-stale": "First" },
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(failedExit));
        expect(failedExit).not.toMatchObject({
          cause: { reasons: [{ error: { retryable: true } }] },
        });

        yield* controller.respondToUserInput({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("question-b"),
          answers: { "question-b": "Second" },
        });
        yield* Effect.yieldNow;
        expect(latestState()).toBe("running");
        yield* Fiber.interrupt(collector);
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

  it.effect(
    "preserves attachment order and typed-array byte ranges during asynchronous reads",
    () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const readAttachment = vi.fn(async (path: string) =>
        path.endsWith("image-1.png")
          ? new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4)
          : new Uint8Array([4, 5]),
      );
      const layer = makeLayer(bridge.service, mastra.factory, undefined, undefined, undefined, {
        readAttachment,
      });
      return Effect.gen(function* () {
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
          input: "Inspect both images.",
          attachments: ["image-1", "image-2"].map((id) => ({
            type: "image" as const,
            id,
            name: `${id}.png`,
            mimeType: "image/png",
            sizeBytes: 3,
          })),
        });
        expect(readAttachment.mock.calls.map(([path]) => NodePath.basename(path))).toEqual([
          "image-1.png",
          "image-2.png",
        ]);
        expect(mastra.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            files: [
              { data: "AQID", mediaType: "image/png", filename: "image-1.png" },
              { data: "BAU=", mediaType: "image/png", filename: "image-2.png" },
            ],
          }),
        );
      }).pipe(Effect.provide(layer), Effect.orDie);
    },
  );

  it.effect("keeps same-thread turn order when an attachment waiter is interrupted", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let finishRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const layer = makeLayer(bridge.service, mastra.factory, undefined, undefined, undefined, {
      readAttachment: async () => {
        readStarted();
        await readGate;
        return Buffer.from("image");
      },
    });
    return Effect.gen(function* () {
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
      bridge.blockNextDispatchAdmission();
      const first = yield* controller
        .sendTurn({
          threadId: codexThreadId,
          input: "First",
          attachments: [
            {
              type: "image",
              id: "image-1",
              name: "first.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => started);
      const second = yield* controller
        .sendTurn({ threadId: codexThreadId, input: "Interrupted waiter" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(second);
      const third = yield* controller
        .sendTurn({ threadId: codexThreadId, input: "Third" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect(mastra.sendMessage).not.toHaveBeenCalled();
      finishRead();
      yield* Effect.promise(bridge.waitForNextDispatchAdmission);
      yield* Fiber.join(third);
      bridge.releaseNextDispatchAdmission();
      yield* Fiber.join(first);
      yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
      mastra.finishSend();
      yield* Effect.promise(() => mastra.waitForSendMessageCount(2));
      mastra.finishSend();
      expect(mastra.sendMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ content: expect.stringContaining("First") }),
      );
      expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, { content: "Third" });
    }).pipe(Effect.provide(layer), Effect.orDie);
  });

  it.effect("interrupts turns waiting for attachment preparation", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let finishRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const layer = makeLayer(bridge.service, mastra.factory, undefined, undefined, undefined, {
      readAttachment: async () => {
        readStarted();
        await readGate;
        return Buffer.from("image");
      },
    });
    return Effect.gen(function* () {
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
      const first = yield* controller
        .sendTurn({
          threadId: codexThreadId,
          input: "Preparing attachment",
          attachments: [
            {
              type: "image",
              id: "image-1",
              name: "first.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        })
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => started);
      const second = yield* controller
        .sendTurn({
          threadId: codexThreadId,
          input: "Waiting for preparation",
        })
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* controller.interruptTurn({ threadId: codexThreadId });
      finishRead();
      expect((yield* Fiber.join(first))._tag).toBe("Failure");
      expect((yield* Fiber.join(second))._tag).toBe("Failure");
      expect(mastra.sendMessage).not.toHaveBeenCalled();
      yield* controller.sendTurn({ threadId: codexThreadId, input: "After interrupt" });
      yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
      expect(mastra.sendMessage).toHaveBeenCalledWith({ content: "After interrupt" });
      mastra.finishSend();
    }).pipe(Effect.provide(layer), Effect.orDie);
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
      getTools: vi.fn(() => ({ "builtin-exa_search": {}, akeru_preview_status: {} })),
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
          akeru: {
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
          (yield* SubscriptionAuthService.forSecretsDir(
            NodePath.join(baseDir, "userdata", "secrets"),
          )).mcpRequestHealth(exaServer.id)?.health,
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
          (yield* SubscriptionAuthService.forSecretsDir(
            NodePath.join(baseDir, "userdata", "secrets"),
          )).mcpRequestHealth(exaServer.id)?.health,
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
      send: vi.fn(async () => ({
        delegationId: DelegationId.make("delegation-child"),
        childThreadId: ThreadId.make("thread-child"),
        childBotId: BotId.make("bot-child"),
        name: "Child",
        phase: "running" as const,
      })),
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

  it.effect("keeps the memory tool for a delegated turn granted memory scopes", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const memoryDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-delegated-grant-"));
    const botMemoryStore = new BotMemoryStore(memoryDir);
    const access: AkeruDelegationAccessGrant = {
      allowedToolIds: ["Read"],
      memoryScopes: ["bot"],
      sandbox: "local",
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "send",
    };
    const runtime = {
      send: vi.fn(async () => {
        throw new Error("not used");
      }),
      sendToUser: vi.fn(async () => {
        throw new Error("not used");
      }),
      parentFinished: vi.fn(async () => undefined),
      accessForThread: () => access,
    };
    const layer = makeLayer(
      bridge.service,
      mastra.factory,
      undefined,
      undefined,
      undefined,
      { botMemoryStore },
      runtime,
    );
    const memoryToolIds = () =>
      mastra.harnessOptions[0]?.toolRuntime
        .toolsForThread(String(codexThreadId))
        .map((tool) => tool.id)
        .filter((id) => id === "memory");

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
        memoryAccess: {
          tenantId: AkeruMemoryTenantId.make("local"),
          userId: AkeruMemoryUserId.make("owner"),
          threadId: codexThreadId,
          projectId: ProjectId.make("delegation-memory-grant"),
          workspaceRoot: process.cwd(),
          botId: BotId.make("delegated-bot"),
          respondingBotId: BotId.make("delegated-bot"),
          groupId: null,
          groupMemberBotIds: [],
        },
      });
      expect(memoryToolIds()).toEqual(["memory"]);
      yield* controller.sendTurn({ threadId: codexThreadId, input: "Do the delegated task." });
      expect(mastra.session.sendMessage).toHaveBeenCalled();
      // Admission runs the turn without durable memory but keeps the granted tool.
      expect(memoryToolIds()).toEqual(["memory"]);
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
        send: vi.fn(async () => ({
          delegationId: DelegationId.make("delegation-child"),
          childThreadId: ThreadId.make("thread-child"),
          childBotId: BotId.make("bot-child"),
          name: "Child",
          phase: "running" as const,
        })),
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
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
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
        send: vi.fn(async () => ({
          delegationId: DelegationId.make("delegation-child"),
          childThreadId: ThreadId.make("thread-child"),
          childBotId: BotId.make("bot-child"),
          name: "Child",
          phase: "running" as const,
        })),
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
        cwd: "/workspace/remote-project",
      });
      // Reusing the remote session without a cwd clears the old project path.
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
      const reusedState = vi.mocked(mastra.session.state.set).mock.calls.at(-1)?.[0];
      expect(reusedState && Object.hasOwn(reusedState, "projectPath")).toBe(true);
      expect(reusedState?.projectPath).toBeUndefined();

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
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
  });

  it.effect("retries failed remote pauses in the background without a new session", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });
    let paused!: () => void;
    const pauseRetried = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const sleep = vi
      .fn()
      .mockRejectedValueOnce(new Error("pause unavailable"))
      .mockImplementation(async () => {
        paused();
      });
    const destroy = vi.fn(async () => undefined);
    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace: async () => ({
        id: "tenki-retry",
        provider: "tenki",
        workspace,
        inspect: async () => "running",
        wake: async () => undefined,
        sleep,
        destroy,
      }),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, makeUsageLedger().service),
          ServerConfig.layerTest(process.cwd(), { prefix: "akeru-pause-retry-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
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
        botSandbox: "tenki",
      });
      yield* controller.stopSession({ threadId: codexThreadId }).pipe(Effect.ignore);
      expect(sleep).toHaveBeenCalledOnce();
      yield* TestClock.adjust("30 seconds");
      yield* Effect.promise(() => pauseRetried);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(destroy).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
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
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);

      expect(secondStop).toHaveBeenCalledOnce();
      expect(secondDestroy).not.toHaveBeenCalled();
    });
  });

  it.effect("waits for observational memory shutdown before closing the controller scope", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const destroyStarted = Promise.withResolvers<void>();
    const destroyReleased = Promise.withResolvers<void>();
    const factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]> = (options) =>
      Effect.acquireRelease(mastra.factory(options), () =>
        Effect.promise(async () => {
          destroyStarted.resolve();
          await destroyReleased.promise;
        }),
      );

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

  it.effect("preserves the Railway VM when an active session rotates credentials", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
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
    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeRemoteWorkspace,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, makeUsageLedger().service),
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

  it.effect("reuses the remote workspace when only cwd changes", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const remote = new Workspace({
      filesystem: new LocalFilesystem({ basePath: process.cwd() }),
      sandbox: new LocalSandbox({ workingDirectory: process.cwd() }),
    });
    const destroy = vi.spyOn(remote, "destroy");
    const makeRemoteWorkspace = vi.fn<
      NonNullable<AgentControllerLiveOptions["makeRemoteWorkspace"]>
    >(async () => remote);
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
      expect(mastra.createSession).toHaveBeenCalledOnce();
      expect(mastra.createSession.mock.calls[0]?.[0]).toMatchObject({ workspace: remote });
      expect(destroy).not.toHaveBeenCalled();
      expect(makeBotBrowser).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
  });

  it.effect("re-acquires the user-computer workspace when cwd changes locally", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const makeBotBrowser = vi.fn(() => ({
      tools: {},
      attachment: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }));
    const layer = makeAgentControllerLive({
      makeMastraHarness: mastra.factory,
      makeBotBrowser: makeBotBrowser as never,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyProviderBridge, bridge.service),
          Layer.succeed(BotUsageLedger, makeUsageLedger().service),
          ServerConfig.layerTest(process.cwd(), {
            prefix: "akeru-mastra-cwd-change-test-",
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      const firstCwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-cwd-a-"));
      const secondCwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-cwd-b-"));
      try {
        const input = {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          modelSelection: codexSelection,
          runtimeMode: "full-access" as const,
        };
        yield* controller.startSession(codexThreadId, { ...input, cwd: firstCwd });
        yield* controller.startSession(codexThreadId, { ...input, cwd: secondCwd });

        const [session] = yield* controller.listSessions();
        assert.equal(session?.cwd, secondCwd);
        // A new Mastra session means the old one and its user-computer
        // workspace lease were torn down instead of reused.
        expect(mastra.createSession).toHaveBeenCalledTimes(2);
      } finally {
        NodeFS.rmSync(firstCwd, { recursive: true, force: true });
        NodeFS.rmSync(secondCwd, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.orDie);
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

  it.effect("adds finished child work to only the next Mastra turn", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const results =
      "<delegated-work-results>\n- Researcher completed: 42\n</delegated-work-results>";
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
        yield* controller.sendTurn({
          threadId: codexThreadId,
          input: "What did the researcher find?",
          delegationResults: results,
        });
        yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
        expect(mastra.session.state.get().persistentMemoryContext).toBe(results);
        expect(mastra.sendMessage).toHaveBeenCalledWith({
          content: "What did the researcher find?",
        });

        // The next turn queues behind the first and starts once it settles.
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Anything else?" });
        mastra.finishSend();
        yield* Effect.promise(() => mastra.waitForSendMessageCount(2));
        expect(mastra.session.state.get()).not.toHaveProperty("persistentMemoryContext");
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    );
  });

  it.effect("adds finished child work to legacy turns for every legacy provider", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    const results =
      "<delegated-work-results>\n- Researcher completed: 42\n</delegated-work-results>";
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        // Claude and Grok on the legacy bridge read context only at session
        // start, so the turn text carries it.
        const threadId = ThreadId.make("thread-legacy-delegation");
        const instanceId = ProviderInstanceId.make("legacyCustom");
        const selection = { instanceId, model: "legacy-model" };
        yield* controller.resolveEngine({
          threadId,
          engine: null,
          fallback: selection,
          mode: "default",
          botConversation: false,
        });
        yield* controller.startSession(threadId, {
          threadId,
          provider: ProviderDriverKind.make("legacyCustom"),
          providerInstanceId: instanceId,
          modelSelection: selection,
          runtimeMode: "full-access",
        });
        yield* controller.sendTurn({
          threadId,
          input: "Summarize it.",
          delegationResults: results,
        });
        const legacyInput = bridge.sendTurn.mock.calls[0]?.[0];
        expect(legacyInput?.input).toBe(`${results}\n\nSummarize it.`);
        expect(legacyInput).not.toHaveProperty("delegationResults");

        // OpenCode reads per-turn context as its system prompt.
        yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "opencode", model: "anthropic/claude-sonnet-4-5" },
          fallback: codexSelection,
          mode: "default",
          botConversation: false,
        });
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("opencode"),
          providerInstanceId: openCodeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        yield* controller.sendTurn({
          threadId: claudeThreadId,
          input: "Summarize it.",
          delegationResults: results,
        });
        const openCodeInput = bridge.sendTurn.mock.calls[1]?.[0];
        expect(openCodeInput?.input).toBe("Summarize it.");
        expect(openCodeInput?.persistentMemoryContext).toContain(results);
        expect(openCodeInput).not.toHaveProperty("delegationResults");
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

  describe("in-session model switch between turns", () => {
    const switchCases = [
      {
        provider: "codex",
        threadId: codexThreadId,
        instanceId: codexInstanceId,
        from: "gpt-5.6-sol",
        to: "gpt-5.6-astra",
        wirePrefix: "openai",
      },
      {
        provider: "claudeAgent",
        threadId: claudeThreadId,
        instanceId: claudeInstanceId,
        from: "claude-fable-5",
        to: "claude-opus-4-6",
        wirePrefix: "anthropic",
      },
      {
        provider: "grok",
        threadId: grokThreadId,
        instanceId: grokInstanceId,
        from: "grok-code-fast-1",
        to: "grok-4.20-beta",
        wirePrefix: "xai",
      },
      {
        provider: "opencodeGo",
        threadId: openCodeGoThreadId,
        instanceId: openCodeGoInstanceId,
        from: "gpt-5.6-sol",
        to: "gpt-5.6-luna",
        wirePrefix: "opencode-go",
      },
    ] as const;

    for (const testCase of switchCases) {
      it.effect(
        `switches the saved ${testCase.provider} model in-session between turns via resolveEngine`,
        () => {
          const bridge = makeBridge();
          const mastra = makeMastraHarness();
          const model = (model: string) => ({
            instanceId: testCase.instanceId,
            model,
          });
          return provideController(
            Effect.gen(function* () {
              const controller = yield* AgentController;
              const resolve = (model: string) =>
                controller.resolveEngine({
                  threadId: testCase.threadId,
                  engine: { provider: String(testCase.instanceId), model },
                  fallback: codexSelection,
                  mode: "default",
                  botConversation: true,
                });
              yield* resolve(testCase.from);
              yield* controller.startSession(testCase.threadId, {
                threadId: testCase.threadId,
                provider: ProviderDriverKind.make(testCase.provider),
                providerInstanceId: testCase.instanceId,
                cwd: process.cwd(),
                modelSelection: model(testCase.from),
                runtimeMode: "approval-required",
              });
              yield* controller.sendTurn({
                threadId: testCase.threadId,
                input: "First turn.",
              });
              yield* Effect.yieldNow;
              mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
              mastra.finishSend();
              yield* Effect.yieldNow;
              expect(mastra.session.model.switch).toHaveBeenCalledWith({
                modelId: `${testCase.wirePrefix}/${testCase.from}`,
              });

              yield* resolve(testCase.to);
              expect(mastra.session.model.switch).toHaveBeenCalledWith({
                modelId: `${testCase.wirePrefix}/${testCase.to}`,
              });
              expect(mastra.createSession).toHaveBeenCalledOnce();

              const completed = yield* controller.streamEvents.pipe(
                Stream.filter((event) => event.type === "turn.completed"),
                Stream.runHead,
                Effect.forkChild({ startImmediately: true }),
              );
              yield* controller.sendTurn({
                threadId: testCase.threadId,
                input: "Second turn.",
                modelSelection: model(testCase.to),
              });
              yield* Effect.yieldNow;
              mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
              mastra.finishSend();
              assert.equal((yield* Fiber.join(completed))._tag, "Some");

              const [session] = yield* controller.listSessions();
              assert.equal(session?.model, testCase.to);
              expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, {
                content: "Second turn.",
              });
              expect(bridge.sendTurn).not.toHaveBeenCalled();
            }),
            bridge.service,
            mastra.factory,
          );
        },
      );
    }

    it.effect("fails closed when the saved model is not in the instance snapshot", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      instanceModelCatalog.set(String(codexInstanceId), { models: ["gpt-5.6-sol"] });
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const failure = yield* Effect.flip(
            controller.resolveEngine({
              threadId: codexThreadId,
              engine: { provider: "codex", model: "not-a-model" },
              fallback: codexSelection,
              mode: "default",
              botConversation: true,
            }),
          );
          assert.equal(failure._tag, "AgentControllerUnsupportedEngineError");
          if (failure._tag === "AgentControllerUnsupportedEngineError") {
            assert.include(failure.detail, "Model 'not-a-model' is not available for codex.");
          }
          expect(mastra.createSession).not.toHaveBeenCalled();
        }),
        bridge.service,
        mastra.factory,
      );
    });

    it.effect("allows a saved model advertised through the instance snapshot", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      instanceModelCatalog.set(String(codexInstanceId), {
        models: ["gpt-5.6-sol", "custom-codex"],
      });
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const resolved = yield* controller.resolveEngine({
            threadId: codexThreadId,
            engine: { provider: "codex", model: "custom-codex" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          assert.equal(resolved.modelSelection.model, "custom-codex");
        }),
        bridge.service,
        mastra.factory,
      );
    });

    it.effect("does not fail closed on a pending snapshot's model list", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      // A pending probe still advertises the built-in catalog. The saved model
      // may be real but only show up once the probe finishes, so the check
      // must not reject it.
      instanceModelCatalog.set(String(codexInstanceId), {
        models: ["gpt-5.6-sol"],
        status: "warning",
      });
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const resolved = yield* controller.resolveEngine({
            threadId: codexThreadId,
            engine: { provider: "codex", model: "cli-only-model" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          assert.equal(resolved.modelSelection.model, "cli-only-model");
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });

  describe("Kimi Mastra normalization", () => {
    const kimiModel = (model: string) => ({
      instanceId: kimiInstanceId,
      model,
    });
    const kimiStartInput = (
      model: string,
      runtimeMode: "approval-required" | "full-access" = "approval-required",
    ) =>
      ({
        threadId: kimiThreadId,
        provider: ProviderDriverKind.make("kimi"),
        providerInstanceId: kimiInstanceId,
        cwd: process.cwd(),
        modelSelection: kimiModel(model),
        runtimeMode,
      }) as const;
    const resolveKimi = (controller: AgentController["Service"], model = "k3-256k") =>
      controller.resolveEngine({
        threadId: kimiThreadId,
        engine: { provider: String(kimiInstanceId), model },
        fallback: codexSelection,
        mode: "default",
        botConversation: true,
      });

    it.effect("normalizes a full Kimi turn with a tool call over the Mastra session", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* resolveKimi(controller);
          yield* controller.startSession(kimiThreadId, kimiStartInput("k3-256k"));

          const events: ProviderRuntimeEvent[] = [];
          const eventsFiber = yield* controller.streamEvents.pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            Effect.forkChild({ startImmediately: true }),
          );
          const completed = yield* controller.streamEvents.pipe(
            Stream.filter(
              (event) => event.type === "turn.completed" && event.payload.state === "completed",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Effect.yieldNow;

          yield* controller.sendTurn({ threadId: kimiThreadId, input: "Read this file." });
          yield* Effect.yieldNow;
          mastra.emit({
            type: "tool_start",
            toolCallId: "read-1",
            toolName: "read_file",
            args: { path: "README.md" },
          } as AgentControllerEvent);
          mastra.emit({
            type: "tool_end",
            toolCallId: "read-1",
            result: "file contents",
            isError: false,
          } as AgentControllerEvent);
          mastra.emit({
            type: "message_end",
            message: {
              ...assistantMessage("Kimi answer"),
              threadId: String(kimiThreadId),
              resourceId: String(kimiThreadId),
            },
          } as AgentControllerEvent);
          mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
          mastra.finishSend();
          const completedEvent = yield* Fiber.join(completed);
          assert.equal(completedEvent._tag, "Some");
          yield* Fiber.interrupt(eventsFiber);

          const types = events.map((event) => event.type);
          for (const expected of [
            "turn.started",
            "session.state.changed",
            "item.started",
            "item.completed",
            "content.delta",
            "turn.completed",
          ]) {
            assert.include(types, expected);
          }
          const itemStarted = events.find((event) => event.type === "item.started");
          expect(itemStarted).toMatchObject({
            payload: { itemType: "file_change", title: "read_file" },
          });
          const toolItem = events.find(
            (event) => event.type === "item.completed" && String(event.itemId ?? "") === "read-1",
          );
          expect(toolItem).toMatchObject({ payload: { status: "completed" } });
          expect(mastra.sendMessage).toHaveBeenCalledWith({ content: "Read this file." });
          expect(mastra.session.model.switch).toHaveBeenCalledWith({
            modelId: "kimi-for-coding/k3-256k",
          });
          expect(bridge.startSession).not.toHaveBeenCalled();
          expect(bridge.sendTurn).not.toHaveBeenCalled();
        }),
        bridge.service,
        mastra.factory,
      );
    });

    it.effect("normalizes a Kimi approval denial to the Mastra session", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* resolveKimi(controller);
          yield* controller.startSession(kimiThreadId, kimiStartInput("k3-256k"));

          const resolved = yield* controller.streamEvents.pipe(
            Stream.filter(
              (event) => event.type === "request.resolved" && event.payload.outcome === "denied",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          const turnEvents = yield* controller.streamEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "turn.completed" ||
                (event.type === "item.completed" && String(event.itemId ?? "") === "shell-1"),
            ),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Effect.yieldNow;
          yield* controller.sendTurn({ threadId: kimiThreadId, input: "Run a shell command." });
          yield* Effect.yieldNow;
          mastra.emit({
            type: "tool_approval_required",
            toolCallId: "shell-1",
            toolName: "Shell",
            args: { command: "rm -rf build" },
          } as AgentControllerEvent);
          yield* Effect.yieldNow;

          yield* controller.respondToRequest({
            threadId: kimiThreadId,
            requestId: ApprovalRequestId.make("shell-1"),
            decision: "decline",
          });
          const resolvedEvent = yield* Fiber.join(resolved);
          assert.equal(resolvedEvent._tag, "Some");

          expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
            toolCallId: "shell-1",
            decision: "decline",
          });
          expect(bridge.respondToRequest).not.toHaveBeenCalled();

          // The denied tool ends the call and the turn can still finish.
          mastra.emit({
            type: "tool_end",
            toolCallId: "shell-1",
            result: "denied",
            denied: true,
          } as AgentControllerEvent);
          mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
          mastra.finishSend();
          const events = yield* Fiber.join(turnEvents);
          const completed = [...events].find((event) => event.type === "turn.completed");
          const itemCompleted = [...events].find((event) => event.type === "item.completed");
          assert.equal(completed?.type, "turn.completed");
          if (completed?.type === "turn.completed") {
            assert.equal(completed.payload.state, "completed");
          }
          expect(itemCompleted).toMatchObject({ payload: { status: "declined" } });
          const [session] = yield* controller.listSessions();
          assert.isUndefined(session?.activeTurnId);
        }),
        bridge.service,
        mastra.factory,
      );
    });

    it.effect("normalizes interrupting a Kimi turn mid-flight through Mastra abort", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* resolveKimi(controller);
          yield* controller.startSession(kimiThreadId, kimiStartInput("k3-256k"));

          const interrupted = yield* controller.streamEvents.pipe(
            Stream.filter(
              (event) => event.type === "turn.completed" && event.payload.state === "interrupted",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          const turn = yield* controller.sendTurn({
            threadId: kimiThreadId,
            input: "Work on this forever.",
          });
          yield* Effect.yieldNow;

          yield* controller.interruptTurn({ threadId: kimiThreadId });
          const event = yield* Fiber.join(interrupted);
          assert.equal(event._tag, "Some");
          if (event._tag === "Some") {
            assert.equal(event.value.turnId, turn.turnId);
          }
          expect(mastra.session.abort).toHaveBeenCalledOnce();
          expect(bridge.interruptTurn).not.toHaveBeenCalled();

          const [session] = yield* controller.listSessions();
          assert.isUndefined(session?.activeTurnId);
        }),
        bridge.service,
        mastra.factory,
      );
    });

    it.effect("resumes a Kimi thread through a fresh controller after a server restart", () => {
      // Restart means the controller scope closes and a new layer is built
      // against the same persisted state directory. A fresh Mastra harness
      // (fresh createSession spies) proves nothing in-memory leaks across
      // the boundary, and the bridge never sees a session call.
      const bridge = makeBridge();
      const mastraBefore = makeMastraHarness();
      const mastraAfter = makeMastraHarness();
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-kimi-restart-"));
      const layer = (factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]>) =>
        makeLayer(bridge.service, factory, undefined, baseDir);

      return Effect.gen(function* () {
        const firstScope = yield* Scope.make("sequential");
        const firstContext = yield* Layer.buildWithScope(layer(mastraBefore.factory), firstScope);
        const first = Context.get(firstContext, AgentController);
        yield* first.resolveEngine({
          threadId: kimiThreadId,
          engine: { provider: String(kimiInstanceId), model: "k3-256k" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* first.startSession(kimiThreadId, kimiStartInput("k3-256k"));
        yield* first.sendTurn({ threadId: kimiThreadId, input: "Before restart." });
        yield* Effect.yieldNow;
        mastraBefore.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastraBefore.finishSend();
        yield* Effect.yieldNow;
        yield* Scope.close(firstScope, Exit.void);
        expect(mastraBefore.session.abort).toHaveBeenCalled();

        const secondScope = yield* Scope.make("sequential");
        const secondContext = yield* Layer.buildWithScope(layer(mastraAfter.factory), secondScope);
        const second = Context.get(secondContext, AgentController);
        // The saved model is re-resolved from the thread's engine selection —
        // not carried over in memory — and the new scope builds a fresh
        // Mastra session for the same thread.
        yield* second.resolveEngine({
          threadId: kimiThreadId,
          engine: { provider: String(kimiInstanceId), model: "k3-256k" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* second.startSession(kimiThreadId, kimiStartInput("k3-256k"));
        const completed = yield* second.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* second.sendTurn({ threadId: kimiThreadId, input: "After restart." });
        yield* Effect.yieldNow;
        mastraAfter.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastraAfter.finishSend();
        assert.equal((yield* Fiber.join(completed))._tag, "Some");

        expect(mastraAfter.createSession).toHaveBeenCalledOnce();
        expect(mastraAfter.session.model.switch).toHaveBeenCalledWith({
          modelId: "kimi-for-coding/k3-256k",
        });
        expect(mastraAfter.sendMessage).toHaveBeenCalledWith({ content: "After restart." });
        yield* Scope.close(secondScope, Exit.void);
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.sendTurn).not.toHaveBeenCalled();
        expect(bridge.stopSession).not.toHaveBeenCalled();
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
        ),
        Effect.orDie,
      );
    });

    it.effect("normalizes a Kimi model switch in-session between turns", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* resolveKimi(controller, "kimi-for-coding");
          yield* controller.startSession(kimiThreadId, kimiStartInput("kimi-for-coding"));
          yield* controller.sendTurn({ threadId: kimiThreadId, input: "First turn." });
          yield* Effect.yieldNow;
          mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
          mastra.finishSend();
          yield* Effect.yieldNow;
          expect(mastra.session.model.switch).toHaveBeenCalledWith({
            modelId: "kimi-for-coding/kimi-for-coding",
          });

          // The user picks a different advertised model; the existing Mastra
          // session absorbs the switch instead of being rebuilt.
          yield* resolveKimi(controller, "kimi-for-coding-highspeed");
          expect(mastra.session.model.switch).toHaveBeenCalledWith({
            modelId: "kimi-for-coding/kimi-for-coding-highspeed",
          });
          expect(mastra.createSession).toHaveBeenCalledOnce();

          const completed = yield* controller.streamEvents.pipe(
            Stream.filter((event) => event.type === "turn.completed"),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* controller.sendTurn({
            threadId: kimiThreadId,
            input: "Second turn.",
            modelSelection: kimiModel("kimi-for-coding-highspeed"),
          });
          yield* Effect.yieldNow;
          mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
          mastra.finishSend();
          assert.equal((yield* Fiber.join(completed))._tag, "Some");

          const [session] = yield* controller.listSessions();
          assert.equal(session?.model, "kimi-for-coding-highspeed");
          expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, { content: "Second turn." });
          expect(bridge.sendTurn).not.toHaveBeenCalled();
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });

  it.effect(
    "runs a real Mastra turn for Kimi through AkeruKimiProvider and a fake transport",
    () => {
      // This is the causal-flow proof the mocked-harness tests cannot give:
      // `sendTurn` drives the real Mastra Session, the resolved model is the
      // real `akeruKimiProvider` Anthropic transport, the scripted SSE reply
      // produces a `tool_approval_required`, the controller response resumes
      // the run, and `turn.completed` lands through the real event pipeline.
      const bridge = makeBridge();
      const kimiRequests: Array<{
        readonly url: string;
        readonly body: string;
        readonly headers: Record<string, string>;
      }> = [];
      // Scripted Kimi replies: the first request emits a Shell tool_use, and
      // the post-approval resume ends the turn with a text reply. The SSE
      // parser only emits a tool_call when the `content_block_start` carries
      // the full `input` object — streaming `input_json_delta` args alone
      // leaves the call without a parsed tool_use payload.
      const toolCallSse =
        [
          "event: message_start",
          'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"kimi-for-coding","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
          "event: content_block_start",
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_shell","name":"Shell","input":{"command":"pwd"}}}',
          "event: content_block_stop",
          'data: {"type":"content_block_stop","index":0}',
          "event: message_delta",
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}',
          "event: message_stop",
          'data: {"type":"message_stop"}',
        ].join("\n\n") + "\n\n";
      const endTurnSse =
        [
          "event: message_start",
          'data: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","model":"kimi-for-coding","content":[],"stop_reason":null,"usage":{"input_tokens":20,"output_tokens":0}}}',
          "event: content_block_start",
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"pwd printed the working directory."}}',
          "event: content_block_stop",
          'data: {"type":"content_block_stop","index":0}',
          "event: message_delta",
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
          "event: message_stop",
          'data: {"type":"message_stop"}',
        ].join("\n\n") + "\n\n";
      const fakeKimi = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = typeof init?.body === "string" ? init.body : "";
        const headers = Object.fromEntries(
          new Headers(input instanceof Request ? input.headers : (init?.headers ?? {})),
        );
        kimiRequests.push({ url, body, headers });
        return new Response(kimiRequests.length === 1 ? toolCallSse : endTurnSse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-kimi-e2e-"));
      NodeFS.mkdirSync(NodePath.join(baseDir, "userdata", "secrets"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(baseDir, "userdata", "secrets", "subscription-auth.json"),
        JSON.stringify({
          "kimi-for-coding": {
            type: "oauth",
            access: "kimi-e2e-token",
            refresh: "kimi-e2e-refresh",
            expires: 4_102_444_800_000,
            deviceId: "0123456789abcdef0123456789abcdef",
          },
        }),
      );

      const originalFetch = globalThis.fetch;
      const fetchPatched = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url.startsWith("https://api.kimi.com/coding/v1/messages")
          ? fakeKimi(input as string | URL | Request, init as RequestInit | undefined)
          : originalFetch(input, init);
      });

      const layer = makeAgentControllerLive({
        makeMastraHarness: makeAkeruMastraHarness,
        makeBotBrowser: () => ({
          tools: {},
          attachment: async () => undefined,
          reconnect: async () => undefined,
          close: async () => undefined,
        }),
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(LegacyProviderBridge, bridge.service),
            Layer.succeed(BotUsageLedger, makeUsageLedger().service),
            Layer.mock(EntityMemoryRepository)({}),
            serverSettingsLayerTest({}),
            ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
            NodeServices.layer,
          ),
        ),
      );

      return Effect.gen(function* () {
        const unrelated = yield* Effect.promise(() =>
          fetch("data:text/plain,unrelated").then((response) => response.text()),
        );
        assert.equal(unrelated, "unrelated");
        assert.equal(kimiRequests.length, 0);
        const scope = yield* Scope.make("sequential");
        const context = yield* Layer.buildWithScope(layer, scope);
        const controller = Context.get(context, AgentController);

        yield* controller.resolveEngine({
          threadId: kimiThreadId,
          engine: { provider: String(kimiInstanceId), model: "kimi-for-coding" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        // No cwd and sandbox: "none" would keep the model's tool list empty;
        // the harness is verified with the real Akeru tool surface, so use a
        // local workspace rooted at the repo checkout.
        yield* controller.startSession(kimiThreadId, {
          threadId: kimiThreadId,
          provider: ProviderDriverKind.make("kimi"),
          providerInstanceId: kimiInstanceId,
          cwd: process.cwd(),
          modelSelection: { instanceId: kimiInstanceId, model: "kimi-for-coding" },
          runtimeMode: "approval-required",
          botSandbox: "local",
        });

        const events: ProviderRuntimeEvent[] = [];
        const collector = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        const opened = yield* controller.streamEvents.pipe(
          Stream.filter(
            (event) => event.type === "request.opened" && event.threadId === kimiThreadId,
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;

        yield* controller.sendTurn({ threadId: kimiThreadId, input: "Run pwd." });
        // The model request is the deterministic fake transport — the turn is
        // now parked on the interactive tool-approval gate the harness raised.
        assert.equal((yield* Fiber.join(opened))._tag, "Some");
        assert.equal(kimiRequests.length, 1);
        expect(kimiRequests[0]!.url).toContain("api.kimi.com/coding/v1/messages");
        expect(kimiRequests[0]!.headers["authorization"]).toBe("Bearer kimi-e2e-token");
        expect(kimiRequests[0]!.headers["x-msh-device-id"]).toBeDefined();

        const completed = yield* controller.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.respondToRequest({
          threadId: kimiThreadId,
          requestId: ApprovalRequestId.make("toolu_shell"),
          decision: "accept",
        });

        // Approving resumes the provider turn; the scripted second model reply
        // completes it. The completion receipt is the proof the whole chain ran.
        yield* Fiber.join(completed).pipe(Effect.timeout(10_000), Effect.orDie);

        // The controller emitted the approval request, the resolved approval,
        // the tool item, and the completed turn — in that causal order.
        const types = events.map((event) => event.type);
        const causalOrder = [
          types.indexOf("turn.started"),
          types.indexOf("request.opened"),
          types.indexOf("request.resolved"),
          types.indexOf("item.completed"),
          types.indexOf("turn.completed"),
        ];
        assert.notInclude(causalOrder, -1);
        assert.deepEqual(
          [...causalOrder].sort((a, b) => a - b),
          causalOrder,
        );
        const resolved = events.find((event) => event.type === "request.resolved");
        expect(resolved).toMatchObject({ payload: { outcome: "approved" } });
        const itemCompleted = events.find((event) => event.type === "item.completed");
        expect(itemCompleted).toMatchObject({ payload: { status: "completed" } });
        const finished = events.find((event) => event.type === "turn.completed");
        expect(finished).toMatchObject({ payload: { state: "completed" } });
        // The resume ran the approved tool call through the runtime and asked
        // the model for its follow-up, so the transport saw a second request
        // carrying the tool result back to Kimi.
        assert.equal(kimiRequests.length, 2);
        expect(kimiRequests[1]!.body).toContain('"tool_result"');
        expect(bridge.sendTurn).not.toHaveBeenCalled();
        expect(bridge.startSession).not.toHaveBeenCalled();

        yield* Fiber.interrupt(collector);
        yield* Scope.close(scope, Exit.void);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            fetchPatched.mockRestore();
            NodeFS.rmSync(baseDir, { recursive: true, force: true });
          }),
        ),
        Effect.orDie,
      );
    },
  );

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

  describe("per-driver wire-format model routing", () => {
    const mastraWireCases = [
      {
        provider: ProviderDriverKind.make("codex"),
        threadId: codexThreadId,
        instanceId: codexInstanceId,
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ] as const,
        wireModelId: "openai/gpt-5.6-sol",
        modelOptions: { reasoningEffort: "high", serviceTier: "priority" },
      },
      {
        provider: ProviderDriverKind.make("claudeAgent"),
        threadId: claudeThreadId,
        instanceId: claudeInstanceId,
        model: "claude-opus-4-6",
        options: [{ id: "effort", value: "max" }] as const,
        wireModelId: "anthropic/claude-opus-4-6",
        modelOptions: undefined,
      },
      {
        provider: ProviderDriverKind.make("grok"),
        threadId: grokThreadId,
        instanceId: grokInstanceId,
        model: "grok-4.20-beta",
        options: undefined,
        wireModelId: "xai/grok-4.20-beta",
        modelOptions: undefined,
      },
      {
        provider: ProviderDriverKind.make("kimi"),
        threadId: kimiThreadId,
        instanceId: kimiInstanceId,
        model: "kimi-for-coding-highspeed",
        options: undefined,
        wireModelId: "kimi-for-coding/kimi-for-coding-highspeed",
        modelOptions: undefined,
      },
      {
        provider: ProviderDriverKind.make("opencodeGo"),
        threadId: openCodeGoThreadId,
        instanceId: openCodeGoInstanceId,
        model: "gpt-5.6-luna",
        options: undefined,
        wireModelId: "opencode-go/gpt-5.6-luna",
        modelOptions: undefined,
      },
    ] as const;

    for (const testCase of mastraWireCases) {
      it.effect(`sends the saved ${testCase.provider} model to the Mastra wire`, () => {
        const bridge = makeBridge();
        const mastra = makeMastraHarness();
        const modelSelection = {
          instanceId: testCase.instanceId,
          model: testCase.model,
          ...(testCase.options ? { options: [...testCase.options] } : {}),
        };
        return provideController(
          Effect.gen(function* () {
            const controller = yield* AgentController;
            yield* controller.resolveEngine({
              threadId: testCase.threadId,
              engine: {
                provider: String(testCase.instanceId),
                model: testCase.model,
                ...(testCase.options ? { options: [...testCase.options] } : {}),
              },
              fallback: codexSelection,
              mode: "default",
              botConversation: true,
            });
            const session = yield* controller.startSession(testCase.threadId, {
              threadId: testCase.threadId,
              provider: testCase.provider,
              providerInstanceId: testCase.instanceId,
              cwd: process.cwd(),
              modelSelection,
              runtimeMode: "approval-required",
            });
            assert.equal(session.provider, testCase.provider);
            assert.equal(session.model, testCase.model);

            yield* controller.sendTurn({ threadId: testCase.threadId, input: "Route me." });
            yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
            mastra.finishSend();
            yield* Effect.yieldNow;

            expect(mastra.session.model.switch).toHaveBeenCalledWith({
              modelId: testCase.wireModelId,
            });
            if (testCase.modelOptions !== undefined) {
              expect(mastra.session.state.set).toHaveBeenLastCalledWith(
                expect.objectContaining({ modelOptions: testCase.modelOptions }),
              );
            }
            expect(mastra.sendMessage).toHaveBeenCalledWith({ content: "Route me." });
            expect(bridge.startSession).not.toHaveBeenCalled();
            expect(bridge.sendTurn).not.toHaveBeenCalled();
          }),
          bridge.service,
          mastra.factory,
        );
      });
    }

    it.effect("sends the saved OpenCode model to the legacy bridge", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      const modelSelection = {
        instanceId: openCodeInstanceId,
        model: "anthropic/claude-sonnet-4-5",
        options: [
          { id: "agent", value: "build" },
          { id: "variant", value: "high" },
        ],
      };
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* controller.resolveEngine({
            threadId: claudeThreadId,
            engine: {
              provider: String(openCodeInstanceId),
              model: "anthropic/claude-sonnet-4-5",
              options: [
                { id: "agent", value: "build" },
                { id: "variant", value: "high" },
              ],
            },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          const session = yield* controller.startSession(claudeThreadId, {
            threadId: claudeThreadId,
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            cwd: process.cwd(),
            modelSelection,
            runtimeMode: "approval-required",
          });
          assert.equal(session.provider, "opencode");

          yield* controller.sendTurn({
            threadId: claudeThreadId,
            input: "Route me.",
            modelSelection,
          });

          expect(bridge.startSession).toHaveBeenCalledOnce();
          expect(bridge.startSession.mock.calls[0]?.[1]).toMatchObject({ modelSelection });
          const sentInput = bridge.sendTurn.mock.calls[0]?.[0];
          expect(sentInput?.threadId).toBe(claudeThreadId);
          expect(sentInput?.modelSelection).toEqual(modelSelection);
          expect(mastra.sendMessage).not.toHaveBeenCalled();
        }),
        bridge.service,
        mastra.factory,
      );
    });

    it.effect.each([
      {
        provider: "codex",
        instanceId: "codex-isolated",
        issue: "This Codex instance needs OPENAI_API_KEY",
      },
      {
        provider: "claudeAgent",
        instanceId: "claudeAgent-isolated",
        issue: "This Claude instance needs an API key or auth token",
      },
      {
        provider: "grok",
        instanceId: "grok-isolated",
        issue: "This Grok instance needs XAI_API_KEY",
      },
      {
        provider: "kimi",
        instanceId: "kimi-isolated",
        issue: "Custom Kimi credentials are not supported",
      },
      {
        provider: "opencodeGo",
        instanceId: "opencodeGo-isolated",
        issue: "This OpenCode Go instance needs OPENCODE_API_KEY",
      },
    ] as const)(
      "fails closed for $provider when no credential transport is configured",
      ({ provider, instanceId: instanceSlug, issue: expectedIssue }) => {
        const bridge = makeBridge();
        const mastra = makeMastraHarness();
        const instanceId = ProviderInstanceId.make(instanceSlug);
        const threadId = ThreadId.make(`thread-${provider.toLowerCase()}-isolated`);
        const service: ProviderServiceShape = {
          ...bridge.service,
          getInstanceInfo: (candidate) =>
            Effect.succeed({
              instanceId: candidate,
              driverKind: ProviderDriverKind.make(provider),
              displayName: undefined,
              enabled: true,
              continuationIdentity: {
                driverKind: ProviderDriverKind.make(provider),
                continuationKey: `${provider}:instance:${candidate}`,
              },
              mastraConnection: {
                environment: {},
                instanceEnvironment: {},
                useSavedCredential: false,
              },
            }),
        };
        return provideController(
          Effect.gen(function* () {
            const controller = yield* AgentController;
            const error = yield* controller
              .resolveEngine({
                threadId,
                engine: { provider, model: "removed-model" },
                fallback: codexSelection,
                mode: "default",
                botConversation: true,
              })
              .pipe(Effect.flip);

            assert.equal(error._tag, "AgentControllerUnsupportedEngineError");
            if (error._tag === "AgentControllerUnsupportedEngineError") {
              assert.include(error.detail, `Provider instance '${provider}' is not available.`);
              const causeMessage =
                error.cause instanceof Error ? error.cause.message : String(error.cause ?? "");
              assert.include(causeMessage, expectedIssue);
            }
            expect(bridge.startSession).not.toHaveBeenCalled();
            expect(bridge.sendTurn).not.toHaveBeenCalled();
            expect(mastra.session.model.switch).not.toHaveBeenCalled();
          }),
          service,
          mastra.factory,
        );
      },
    );

    it.effect("fails closed for a disabled saved provider instead of rerouting", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          bridge.setInstanceEnabled(false);
          const error = yield* controller
            .resolveEngine({
              threadId: claudeThreadId,
              engine: { provider: String(claudeInstanceId), model: "claude-opus-4-6" },
              fallback: codexSelection,
              mode: "default",
              botConversation: true,
            })
            .pipe(Effect.flip);

          assert.equal(error._tag, "ProviderValidationError");
          if (error._tag === "ProviderValidationError") {
            assert.include(error.issue, "disabled in Akeru Bot settings");
          }
          expect(bridge.startSession).not.toHaveBeenCalled();
          expect(bridge.sendTurn).not.toHaveBeenCalled();
          expect(mastra.session.model.switch).not.toHaveBeenCalled();
        }),
        bridge.service,
        mastra.factory,
      );
    });

    it.effect("routes two bots on the same Codex instance to different models", () => {
      const bridge = makeBridge();
      const sessionsByThread = new Map<
        string,
        {
          model: { switch: ReturnType<typeof vi.fn> };
          sendMessage: ReturnType<typeof vi.fn>;
        }
      >();
      const factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]> = () =>
        Effect.succeed({
          controller: {
            init: vi.fn(async () => undefined),
            createSession: vi.fn(async (input: { readonly id: string }) => {
              const switchSpy = vi.fn(async () => undefined);
              const sendMessage = vi.fn(() => Promise.resolve());
              sessionsByThread.set(input.id, {
                model: { switch: switchSpy },
                sendMessage,
              });
              return {
                state: {
                  get: () => ({}),
                  set: vi.fn(async () => undefined),
                },
                mode: {
                  get: () => "build",
                  switch: vi.fn(async () => undefined),
                },
                model: { get: () => "", switch: switchSpy },
                permissions: {
                  setForCategory: vi.fn(async () => undefined),
                  setForTool: vi.fn(async () => undefined),
                },
                grantTool: vi.fn(),
                subscribe: vi.fn(() => () => undefined),
                sendMessage,
                abort: vi.fn(),
                respondToToolApproval: vi.fn(),
                respondToToolSuspension: vi.fn(async () => undefined),
              } as unknown as Session<Record<string, unknown>>;
            }),
            deleteSession: vi.fn(async () => true),
          },
          observeExternalTurn: vi.fn(async () => undefined),
        });
      const codexWorkThread = ThreadId.make("thread-codex-work");
      const codexReviewThread = ThreadId.make("thread-codex-review");

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          for (const [threadId, model] of [
            [codexWorkThread, "gpt-5.6-sol"],
            [codexReviewThread, "gpt-5.6-codex-mini"],
          ] as const) {
            yield* controller.resolveEngine({
              threadId,
              engine: { provider: "codex", model },
              fallback: { instanceId: codexInstanceId, model },
              mode: "default",
              botConversation: true,
            });
            yield* controller.startSession(threadId, {
              threadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: codexInstanceId,
              cwd: process.cwd(),
              modelSelection: { instanceId: codexInstanceId, model },
              runtimeMode: "approval-required",
            });
            yield* controller.sendTurn({ threadId, input: `Use ${model}.` });
          }

          expect(sessionsByThread.get(String(codexWorkThread))?.model.switch).toHaveBeenCalledWith({
            modelId: "openai/gpt-5.6-sol",
          });
          expect(
            sessionsByThread.get(String(codexReviewThread))?.model.switch,
          ).toHaveBeenCalledWith({ modelId: "openai/gpt-5.6-codex-mini" });
          expect(sessionsByThread.get(String(codexWorkThread))?.sendMessage).toHaveBeenCalledWith({
            content: "Use gpt-5.6-sol.",
          });
          expect(sessionsByThread.get(String(codexReviewThread))?.sendMessage).toHaveBeenCalledWith(
            { content: "Use gpt-5.6-codex-mini." },
          );
          expect(bridge.startSession).not.toHaveBeenCalled();
          expect(bridge.sendTurn).not.toHaveBeenCalled();
        }),
        bridge.service,
        factory,
      );
    });
  });
});
