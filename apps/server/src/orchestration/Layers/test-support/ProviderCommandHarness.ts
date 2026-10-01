// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { type McpServer, ProviderInstanceId } from "@akeru/contracts";
import { createModelSelection } from "@akeru/shared/model";
import {
  BotId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DelegationId,
  EventId,
  ThreadId,
} from "@akeru/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../../config.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionBotRepositoryLive } from "../../../persistence/Layers/ProjectionBots.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { AgentController } from "../../../provider/Services/AgentController.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration } from "../../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../ThreadPlanProgress.ts";
import { ProviderCommandReactorLive } from "../ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../../Services/ProviderCommandReactor.ts";
import { ProjectionSnapshotQuery } from "../../Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { BotUsageLedger, BotUsageLedgerLive } from "../../../usage/BotUsageLedger.ts";
import { ComposioService } from "../../../composio/ComposioService.ts";
import {
  createProviderCommandMocks,
  type ProviderCommandHarnessOptions,
} from "./ProviderCommandMocks.ts";
import {
  deriveServerPathsSync,
  asProjectId,
  asMessageId,
  asTurnId,
} from "./ProviderCommandFixtures.ts";
export * from "./ProviderCommandFixtures.ts";

export function createProviderCommandHarness() {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor | ProjectionSnapshotQuery | BotUsageLedger,
    unknown
  > | null = null;

  let scope: Scope.Closeable | null = null;

  const createdStateDirs = new Set<string>();

  const createdBaseDirs = new Set<string>();

  async function createHarness(input?: ProviderCommandHarnessOptions) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const {
      runtimeSessions,
      modelSelection,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      pruneWorktrees,
      createWorktree,
      generateBranchName,
      generateThreadTitle,
      providerSnapshots,
      resolveEngine,
      failDelegation,
      service,
      observations,
    } = createProviderCommandMocks(input, now);

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    let failingCommandReadModelReads = 0;
    const projectionSnapshotLayer = Layer.effect(
      ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.pipe(
        Effect.map((query) => ({
          ...query,
          getCommandReadModel: () =>
            Effect.suspend(() => {
              if (failingCommandReadModelReads === 0) return query.getCommandReadModel();
              failingCommandReadModelReads -= 1;
              return Effect.fail(
                new PersistenceSqlError({
                  operation: "ProjectionSnapshotQuery.getCommandReadModel:test",
                  detail: "Injected command read model failure",
                }),
              );
            }),
        })),
      ),
    ).pipe(
      Layer.provideMerge(
        OrchestrationProjectionSnapshotQueryLive.pipe(
          Layer.provide(ThreadBackgroundLiveness.layer),
          Layer.provide(ThreadPlanProgress.layer),
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provide(SqlitePersistenceMemory),
        ),
      ),
    );
    let titleRegenerationCompletionDispatchAttempts = 0;
    let failingDelegationReleases = 0;
    let sequenceReads = 0;
    const reactorOrchestrationLayer = Layer.effect(
      OrchestrationEngineService,
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        return {
          readEvents:
            input?.failStartupReplay === true
              ? () => Stream.die(new Error("Injected startup replay failure"))
              : engine.readEvents,
          readThreadEvents: engine.readThreadEvents,
          getThreadReplayStats: engine.getThreadReplayStats,
          dispatch: (command) => {
            if (command.type === "thread.title.regeneration.complete") {
              titleRegenerationCompletionDispatchAttempts += 1;
              if (
                titleRegenerationCompletionDispatchAttempts <=
                (input?.titleRegenerationCompletionDispatchFailures ?? 0)
              ) {
                return Effect.die(new Error("Injected title regeneration completion failure"));
              }
            }
            if (
              command.type === "delegation.state.set" &&
              command.commandId.startsWith("server:delegation-release:") &&
              failingDelegationReleases > 0
            ) {
              failingDelegationReleases -= 1;
              return Effect.fail(
                new PersistenceSqlError({
                  operation: "OrchestrationEngine.dispatch:test",
                  detail: "Injected delegation release failure",
                }),
              );
            }
            return engine.dispatch(command);
          },
          get streamDomainEvents() {
            return engine.streamDomainEvents;
          },
          subscribeDomainEvents:
            input?.replayPersistedResumeOnSubscribe === true
              ? engine.subscribeDomainEvents.pipe(
                  Effect.flatMap((liveEvents) =>
                    engine.latestSequence.pipe(
                      Effect.flatMap((throughSequence) =>
                        Stream.runCollect(
                          engine.readThreadEvents({
                            threadId: ThreadId.make("thread-1"),
                            fromSequenceExclusive: 0,
                            toSequenceInclusive: throughSequence,
                            limit: 500,
                          }),
                        ).pipe(Effect.orDie),
                      ),
                      Effect.map((events) => {
                        const resume = Array.from(events).findLast(
                          (event) => event.type === "thread.turn-resume-requested",
                        );
                        return resume
                          ? Stream.concat(Stream.make(resume, resume), liveEvents)
                          : liveEvents;
                      }),
                    ),
                  ),
                )
              : engine.subscribeDomainEvents,
          latestSequence:
            input?.commitDuringSequenceRead === undefined
              ? engine.latestSequence
              : Effect.suspend(() => {
                  sequenceReads += 1;
                  if (sequenceReads !== input.commitDuringSequenceRead)
                    return engine.latestSequence;
                  // The first read precedes the reactor's subscription, so a commit
                  // after it lands in the gap. The second read follows the
                  // subscription, so a commit before it is buffered and counted.
                  const commit = engine
                    .dispatch({
                      type: "thread.meta.update",
                      commandId: CommandId.make("cmd-commit-during-sequence-read"),
                      threadId: ThreadId.make("thread-1"),
                      regenerateTitle: true,
                    })
                    .pipe(Effect.orDie);
                  const titleUpdates = Effect.forEach(
                    Array.from(
                      { length: input.titleUpdatesBeforeStartupCommit ?? 0 },
                      (_, index) => index,
                    ),
                    (index) =>
                      engine
                        .dispatch({
                          type: "thread.meta.update",
                          commandId: CommandId.make(`cmd-startup-title-${index}`),
                          threadId: ThreadId.make("thread-1"),
                          title: `Startup title ${index}`,
                        })
                        .pipe(Effect.orDie),
                    { discard: true },
                  ).pipe(Effect.andThen(commit));
                  return sequenceReads === 1
                    ? engine.latestSequence.pipe(Effect.tap(() => titleUpdates))
                    : titleUpdates.pipe(Effect.andThen(engine.latestSequence));
                }),
        } satisfies OrchestrationEngineService["Service"];
      }),
    ).pipe(Layer.provide(orchestrationLayer));
    const botUsageLedgerLayer = Layer.effect(
      BotUsageLedger,
      BotUsageLedger.pipe(
        Effect.map((ledger) => ({
          ...ledger,
          bindTurn: (binding: Parameters<typeof ledger.bindTurn>[0]) =>
            (input?.bindTurnFailure ? Effect.die("bind failed") : ledger.bindTurn(binding)).pipe(
              Effect.tap(() => observations.publish(undefined)),
            ),
        })),
      ),
    ).pipe(Layer.provide(BotUsageLedgerLive.pipe(Layer.provide(SqlitePersistenceMemory))));
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(reactorOrchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(ProjectionBotRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))),
      Layer.provideMerge(botUsageLedgerLayer),
      Layer.provideMerge(Layer.succeed(AgentController, service)),
      Layer.provideMerge(
        Layer.mock(ComposioService, {
          resolveRuntimeMcpServer:
            input?.composioResolveRuntimeMcpServer ??
            (() => Effect.succeed<McpServer | undefined>(undefined)),
        }),
      ),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
          pruneWorktrees,
          createWorktree,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest(
          input?.enableAgentBrowserAccess === undefined
            ? {}
            : { enableAgentBrowserAccess: input.enableAgentBrowserAccess },
        ),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const managedRuntime = ManagedRuntime.make(layer);
    runtime = managedRuntime;

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const runEffect = <A, E>(effect: Effect.Effect<A, E>) => runtime!.runPromise(effect);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    if (input?.botEngine !== undefined) {
      await Effect.runPromise(
        engine.dispatch({
          type: "bot.create",
          commandId: CommandId.make("cmd-bot-create"),
          botId: BotId.make("bot-1"),
          name: "Configured bot",
          title: "Configured bot",
          avatar: { kind: "dither", seed: "configured-bot" },
          engine: input.botEngine,
          sandbox: "local",
          runtimeMode: "approval-required",
          usageCap: input.botUsageCap ?? null,
          groupId: null,
          createdAt: now,
        }),
      );
    }
    if (input?.secondBot !== undefined) {
      await Effect.runPromise(
        engine.dispatch({
          type: "bot.create",
          commandId: CommandId.make("cmd-bot-create-2"),
          botId: BotId.make("bot-2"),
          name: "Second bot",
          title: "Second bot",
          avatar: { kind: "dither", seed: "second-bot" },
          engine: input.secondBot.engine,
          sandbox: "local",
          runtimeMode: "approval-required",
          usageCap: null,
          groupId: null,
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-2"),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-1"),
          botId: BotId.make("bot-2"),
          title: "Thread 2",
          modelSelection:
            input.secondBot.modelSelection ??
            createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-sol"),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    }
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        ...(input?.botEngine !== undefined ? { botId: BotId.make("bot-1") } : {}),
        ...(input?.delegatedChild === true
          ? {
              parentThreadId: ThreadId.make("thread-parent"),
              parentDelegationId: DelegationId.make("delegation-before-restart"),
            }
          : {}),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        if (
          input?.turnStartBeforeReactor === true ||
          input?.runningTurnBeforeReactor === true ||
          input?.resumeBeforeReactor === true
        ) {
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-turn-start-before-reactor"),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: asMessageId("user-message-before-reactor"),
              role: "user",
              text: "recover this persisted request",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: now,
          });
        }
        if (input?.runningTurnBeforeReactor === true || input?.resumeBeforeReactor === true) {
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-running-before-reactor"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "running",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              mcpServerIds: [],
              activeTurnId: asTurnId("turn-before-reactor"),
              lastError: null,
              updatedAt: now,
            },
            createdAt: now,
          });
          if (input.pendingRequestBeforeReactor) {
            const requestId = `${input.pendingRequestBeforeReactor}-before-restart`;
            yield* engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(`cmd-${requestId}`),
              threadId: ThreadId.make("thread-1"),
              activity: {
                id: EventId.make(`activity-${requestId}`),
                tone: input.pendingRequestBeforeReactor === "approval" ? "approval" : "info",
                kind:
                  input.pendingRequestBeforeReactor === "approval"
                    ? "approval.requested"
                    : "user-input.requested",
                summary:
                  input.pendingRequestBeforeReactor === "approval"
                    ? "Approval requested"
                    : "User input requested",
                payload:
                  input.pendingRequestBeforeReactor === "approval"
                    ? { requestId, requestKind: "command" }
                    : {
                        requestId,
                        questions: [
                          {
                            id: "choice",
                            header: "Choice",
                            question: "Continue?",
                            options: [{ label: "Yes", description: "Continue the work" }],
                          },
                        ],
                      },
                turnId: asTurnId("turn-before-reactor"),
                createdAt: now,
              },
              createdAt: now,
            });
          }
        }
        if (input?.resumeBeforeReactor === true) {
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-error-before-resume"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "error",
              providerName: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "approval-required",
              mcpServerIds: [],
              activeTurnId: null,
              lastError: "Automatic recovery failed.",
              updatedAt: now,
            },
            createdAt: now,
          });
          yield* engine.dispatch({
            type: "thread.turn.resume",
            commandId: CommandId.make("cmd-resume-before-reactor"),
            threadId: ThreadId.make("thread-1"),
            createdAt: now,
          });
        }
      }),
    );
    if (input?.titleRegenerationBeforeStart === "two") {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-2"),
          threadId: ThreadId.make("thread-2"),
          projectId: asProjectId("project-1"),
          title: "Thread 2",
          modelSelection: modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    }
    const titleRegenerationThreadIds =
      input?.titleRegenerationBeforeStart === "two"
        ? [ThreadId.make("thread-1"), ThreadId.make("thread-2")]
        : input?.titleRegenerationBeforeStart === "one"
          ? [ThreadId.make("thread-1")]
          : [];
    for (const [index, threadId] of titleRegenerationThreadIds.entries()) {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(
            `cmd-thread-title-regeneration-before-reactor-start-${index + 1}`,
          ),
          threadId,
          regenerateTitle: true,
        }),
      );
    }

    scope = await Effect.runPromise(Scope.make("sequential"));
    const domainEvents = await runtime.runPromise(
      engine.subscribeDomainEvents.pipe(Scope.provide(scope)),
    );
    await runtime.runPromise(
      Stream.runForEach(domainEvents, () => observations.publish(undefined)).pipe(
        Effect.forkIn(scope),
      ),
    );
    if (input?.startReactor !== false) {
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    }
    const drain = () => Effect.runPromise(reactor.drain);

    return {
      waitFor: (predicate: () => boolean | Promise<boolean>, timeoutMs = 10000) =>
        runtime!.runPromise(
          observations.readUntil(
            Effect.promise(async () => predicate()),
            (value) => value,
            "mock call or command state",
            timeoutMs,
          ),
        ),
      run: <A, E>(effect: Effect.Effect<A, E>) => runtime!.runPromise(effect),
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      resolveEngine,
      failDelegation,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      pruneWorktrees,
      createWorktree,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      stateDir,
      drain,
      runEffect,
      // Builds and starts another reactor over the same persistence. Closing
      // its scope stops it the way a server shutdown would.
      startReactor: (reactorScope: Scope.Scope) =>
        managedRuntime.runPromise(
          Effect.gen(function* () {
            const context = yield* Layer.build(Layer.fresh(ProviderCommandReactorLive));
            const started = Context.get(context, ProviderCommandReactor);
            yield* started.start();
            return started;
          }).pipe(Scope.provide(reactorScope)),
        ),
      summarizeBotUsage: () =>
        runtime!.runPromise(
          BotUsageLedger.pipe(Effect.flatMap((ledger) => ledger.summarize(BotId.make("bot-1")))),
        ),
      failNextCommandReadModelReads: (count: number) => {
        failingCommandReadModelReads = count;
      },
      failNextDelegationReleases: (count: number) => {
        failingDelegationReleases = count;
      },
      get titleRegenerationCompletionDispatchAttempts() {
        return titleRegenerationCompletionDispatchAttempts;
      },
    };
  }
  const dispose = async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  };
  return {
    createHarness,
    dispose,
    get runtime() {
      return runtime;
    },
    get scope() {
      return scope;
    },
  };
}
