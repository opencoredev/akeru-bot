// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import {
  ApprovalRequestId,
  CodexSettings,
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import type { CodexAdapterShape } from "../../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../../Services/ProviderSessionDirectory.ts";
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
  type CodexThreadSnapshot,
} from "../CodexSessionRuntime.ts";
import { makeCodexAdapter } from "../CodexAdapter.ts";

export const decodeCodexSettings = Schema.decodeSync(CodexSettings);

export class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "akeru-bot/provider/Layers/test-support/codexAdapterHarness/CodexAdapter",
) {}

export const asThreadId = (value: string): ThreadId => ThreadId.make(value);

export const asTurnId = (value: string): TurnId => TurnId.make(value);

export const asEventId = (value: string): EventId => EventId.make(value);

export const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);

export class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private readonly now = "2026-01-01T00:00:00.000Z";

  public readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
  );

  public readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
      }),
  );

  public readonly interruptTurnImpl = vi.fn(
    (_turnId?: TurnId): Promise<void> => Promise.resolve(undefined),
  );

  public readonly readThreadImpl = vi.fn(
    (): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

  public readonly rollbackThreadImpl = vi.fn(
    (_numTurns: number): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

  public readonly uploadFeedbackImpl = vi.fn((_reason?: string) =>
    Promise.resolve({ threadId: "provider-thread-1" }),
  );

  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly respondToUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));

  readonly options: CodexSessionRuntimeOptions;

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }

  start() {
    return Effect.promise(() => this.startImpl());
  }

  getSession = Effect.promise(() => this.startImpl());

  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
    return Effect.promise(() => this.sendTurnImpl(input));
  }

  interruptTurn(turnId?: TurnId) {
    return Effect.promise(() => this.interruptTurnImpl(turnId));
  }

  readThread = Effect.promise(() => this.readThreadImpl());

  rollbackThread(numTurns: number) {
    return Effect.promise(() => this.rollbackThreadImpl(numTurns));
  }

  uploadFeedback(reason?: string) {
    return Effect.promise(() => this.uploadFeedbackImpl(reason));
  }

  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision));
  }

  respondToUserInput(requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) {
    return Effect.promise(() => this.respondToUserInputImpl(requestId, answers));
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.promise(() => this.closeImpl());

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}

export function makeCodexAdapterHarness() {
  function makeRuntimeFactory() {
    const runtimes: Array<FakeCodexRuntime> = [];

    const factory = vi.fn((options: CodexSessionRuntimeOptions) => {
      const runtime = new FakeCodexRuntime(options);
      runtimes.push(runtime);

      return Effect.succeed(runtime);
    });

    return {
      factory,
      get lastRuntime(): FakeCodexRuntime | undefined {
        return runtimes.at(-1);
      },
    };
  }

  function makeScopedRuntimeFactory(options?: { readonly failConstruction?: boolean }) {
    const runtimes: Array<FakeCodexRuntime> = [];
    const releasedThreadIds: Array<ThreadId> = [];

    const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
      Effect.gen(function* () {
        yield* Scope.Scope;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releasedThreadIds.push(runtimeOptions.threadId);
          }),
        );

        if (options?.failConstruction) {
          return yield* new CodexErrors.CodexAppServerSpawnError({
            command: `${runtimeOptions.binaryPath} app-server`,
            cause: new Error("runtime construction failed"),
          });
        }

        const runtime = new FakeCodexRuntime(runtimeOptions);
        runtimes.push(runtime);

        return runtime;
      }),
    );

    return {
      factory,
      releasedThreadIds,
      get lastRuntime(): FakeCodexRuntime | undefined {
        return runtimes.at(-1);
      },
    };
  }

  const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
    upsert: () => Effect.void,
    getProvider: () =>
      Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
    getBinding: () => Effect.succeed(Option.none()),
    listThreadIds: () => Effect.succeed([]),
    listBindings: () => Effect.succeed([]),
  });

  const validationRuntimeFactory = makeRuntimeFactory();

  const validationLayer = it.layer(
    Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});

        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: validationRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  const sessionRuntimeFactory = makeRuntimeFactory();

  const sessionErrorLayer = it.layer(
    Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});

        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: sessionRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  const lifecycleRuntimeFactory = makeRuntimeFactory();

  const lifecycleLayer = it.layer(
    Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});

        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: lifecycleRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  function startLifecycleRuntime() {
    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      const runtime = lifecycleRuntimeFactory.lastRuntime;
      NodeAssert.ok(runtime);

      return { adapter, runtime };
    });
  }

  const scopedLifecycleRuntimeFactory = makeScopedRuntimeFactory();

  const scopedLifecycleLayer = it.layer(
    Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});

        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: scopedLifecycleRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  const scopedFailureRuntimeFactory = makeScopedRuntimeFactory({ failConstruction: true });

  const scopedFailureLayer = it.layer(
    Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});

        return yield* makeCodexAdapter(codexConfig, {
          makeRuntime: scopedFailureRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

  return {
    makeRuntimeFactory,
    makeScopedRuntimeFactory,
    providerSessionDirectoryTestLayer,
    validationRuntimeFactory,
    validationLayer,
    sessionRuntimeFactory,
    sessionErrorLayer,
    lifecycleRuntimeFactory,
    lifecycleLayer,
    startLifecycleRuntime,
    scopedLifecycleRuntimeFactory,
    scopedLifecycleLayer,
    scopedFailureRuntimeFactory,
    scopedFailureLayer,
  };
}
