import { emptyProviderSnapshot, providerThreadFixture } from "./projectionFixtures.ts";
import { sessionFixture } from "./partialFixtures.ts";
import type { AkeruMastraState } from "../../AkeruMastraHarness.ts";

import * as Match from "effect/Match";
// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentControllerEvent, Session } from "@mastra/core/agent-controller";
import {
  BotId,
  GroupId,
  McpServerId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
  type McpServer,
  type OrchestrationReadModel,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { assert, vi } from "vite-plus/test";
import { ServerConfig } from "../../../config.ts";
import {
  ServerSettingsService,
  layerTest as serverSettingsLayerTest,
} from "../../../serverSettings.ts";
import { EntityMemoryRepository } from "../../../memory/Services/EntityMemoryRepository.ts";
import { AgentController } from "../../Services/AgentController.ts";
import { ProviderValidationError } from "../../Errors.ts";
import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";
import type { ProviderServiceShape } from "../../Services/ProviderService.ts";
import { agentControllerLayerWith, type AgentControllerLiveOptions } from "../AgentController.ts";
import {
  RoutineDraftDispatcher,
  type RoutineDraftDispatcherShape,
} from "../../../routines/RoutineDraftDispatcher.ts";
import { BotUsageLedger, type BotUsageLedgerShape } from "../../../usage/BotUsageLedger.ts";
import {
  codexThreadId,
  claudeThreadId,
  grokThreadId,
  kimiThreadId,
  openCodeGoThreadId,
  codexInstanceId,
  claudeInstanceId,
  grokInstanceId,
  kimiInstanceId,
  openCodeGoInstanceId,
  codexSelection,
  instanceModelCatalog,
} from "./agentControllerFixtures.ts";
import { usageLedgerFixture } from "./agentControllerMemory.ts";
import { mastraHarnessFixture } from "./agentControllerHarness.ts";

export function makeProviderSession(
  threadId: ThreadId,
  provider: "codex" | "claudeAgent" | "opencode",
): ProviderSession {
  return {
    provider: ProviderDriverKind.make(provider),
    providerInstanceId: ProviderInstanceId.make(provider),
    threadId,
    status: "ready",
    runtimeMode: "full-access",
    model: Match.value(provider).pipe(
      Match.when("codex", () => "gpt-5.6-sol" as const),
      Match.when("opencode", () => "anthropic/claude-sonnet-4-5" as const),
      Match.orElse(() => "claude-fable-5" as const),
    ),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function makeInstanceSnapshot(
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

export function makeBridge() {
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
        Match.value(String(input.provider)).pipe(
          Match.when("codex", () => "codex" as const),
          Match.when("opencode", () => "opencode" as const),
          Match.orElse(() => "claudeAgent" as const),
        ),
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

export function makeLayer(
  bridge: ProviderServiceShape,
  factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]>,
  makeMcpManager?: NonNullable<AgentControllerLiveOptions["makeMcpManager"]>,
  baseDir?: string,
  usageLedger: BotUsageLedgerShape = usageLedgerFixture().service,
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
  return agentControllerLayerWith({
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

export function provideController<A, E>(
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

export function resolveCodex(controller: AgentController["Service"]) {
  return controller.resolveEngine({
    threadId: codexThreadId,
    engine: { provider: "codex", model: "gpt-5.6-sol" },
    fallback: codexSelection,
    mode: "default",
    botConversation: true,
  });
}

export const routineInput = {
  name: "Morning summary",
  instructions: "Summarize overnight changes.",
  schedule: { kind: "daily", time: "09:00" },
} as const;

export const openRoutineReview = (
  mastra: ReturnType<typeof mastraHarnessFixture>,
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

export const provideRoutineController = <A, E>(
  effect: Effect.Effect<A, E, AgentController | ServerSettingsService>,
  mastra: ReturnType<typeof mastraHarnessFixture>,
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

export const bossBotId = BotId.make("bot-boss");

export const linearServer: McpServer = {
  id: McpServerId.make("linear"),
  name: "Linear",
  transport: "url",
  url: "https://mcp.example.com/linear",
  enabled: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

export const groupParentSnapshot = {
  ...emptyProviderSnapshot(),
  threads: [
    providerThreadFixture({
      id: codexThreadId,
      projectId: ProjectId.make("project-workers"),
      botId: null,
      groupId: GroupId.make("group-workers"),
      respondingBotId: bossBotId,
      runtimeMode: "approval-required",
      modelSelection: codexSelection,
      branch: null,
      worktreePath: null,
    }),
  ],
  bots: [],
  groups: [],
  delegations: [],
} satisfies OrchestrationReadModel;

export const makeWorkerSession = (base: Session<AkeruMastraState>) => {
  const listeners = new Set<(event: AgentControllerEvent) => void>();

  const session = sessionFixture({
    ...base,
    subscribe: vi.fn((listener: (event: AgentControllerEvent) => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    }),
    sendMessage: vi.fn(() => new Promise<void>(() => undefined)),
    respondToToolApproval: vi.fn(),
  });

  return {
    session,
    emit: (event: AgentControllerEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
};

export const switchCases = [
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

export const kimiModel = (model: string) => ({
  instanceId: kimiInstanceId,
  model,
});

export const kimiStartInput = (
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

export const resolveKimi = (controller: AgentController["Service"], model = "k3-256k") =>
  controller.resolveEngine({
    threadId: kimiThreadId,
    engine: { provider: String(kimiInstanceId), model },
    fallback: codexSelection,
    mode: "default",
    botConversation: true,
  });

export const mastraWireCases = [
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
