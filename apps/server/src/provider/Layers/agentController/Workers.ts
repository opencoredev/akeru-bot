import type { AgentControllerLiveOptions } from "./Options.ts";
// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off
import * as NodeCrypto from "node:crypto";

import { CommandId, MessageId, ThreadId, type AkeruDelegationAccessGrant } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import { type AkeruChannelRuntime } from "../../AkeruChannelRuntime.ts";
import { type AkeruBotStateRuntime } from "../../AkeruBotStateRuntime.ts";

import {
  AkeruWorkerError,
  makeAkeruWorkerRuntime,
  WORKER_THREAD_ID_PREFIX,
} from "../../AkeruWorkerRuntime.ts";

import {
  createAkeruPluginRuntime,
  type AkeruPluginRuntimeOptions,
} from "../../AkeruCatalogToolHandlers.ts";

import { type AkeruToolSession } from "../../AkeruToolRuntime.ts";

import { AgentControllerRuntimeError } from "../../Errors.ts";

import { type ActiveSession, type WorkerOrchestration } from "./State.ts";

import { nowIso } from "./EventIdentity.ts";

export function createWorkers(deps: {
  readonly runMastra: <A>(
    operation: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) => Effect.Effect<A, AgentControllerRuntimeError, never>;
  readonly wired: () => {
    readonly channelRuntime?: AkeruChannelRuntime;
    readonly pluginRuntime?: ReturnType<typeof createAkeruPluginRuntime>;
    readonly pluginRuntimeOptions?: AkeruPluginRuntimeOptions;
    readonly botStateRuntime?: AkeruBotStateRuntime;
    readonly delegationRuntime?: AgentControllerLiveOptions["delegationRuntime"];
    readonly workerOrchestration?: WorkerOrchestration;
  };
  readonly sessions: Map<string, ActiveSession>;
  readonly workerTurnDefaults: Map<
    string,
    "approval-required" | "auto-accept-edits" | "auto" | "full-access"
  >;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}) {
  return Effect.gen(function* () {
    const workerCall = <A>(run: (orchestration: WorkerOrchestration) => Promise<A>) =>
      deps
        .runMastra("worker.orchestration", () => {
          const orchestration = deps.wired().workerOrchestration;
          if (!orchestration) throw new Error("Workers need the orchestration engine.");
          return run(orchestration);
        })
        .pipe(
          Effect.mapError(
            (error) => new AkeruWorkerError({ reason: "start_failed", detail: error.detail }),
          ),
        );
    const workerRuntime = yield* makeAkeruWorkerRuntime({
      createChild: (spec) =>
        workerCall(async (orchestration) => {
          const snapshot = await orchestration.readSnapshot();
          const parentThread = snapshot.threads.find(
            (candidate) => candidate.id === spec.parentThreadId,
          );
          if (!parentThread) throw new Error(`Chat '${spec.parentThreadId}' was not found.`);
          const botId =
            deps.sessions.get(String(spec.parentThreadId))?.toolSession.botId ??
            parentThread.respondingBotId ??
            parentThread.botId ??
            null;
          const childThreadId = ThreadId.make(
            `${WORKER_THREAD_ID_PREFIX}${NodeCrypto.randomUUID()}`,
          );
          deps.workerTurnDefaults.set(String(childThreadId), parentThread.runtimeMode);
          // A worker is a direct copy of the responding bot, never a group chat,
          // even when the parent is one.
          await orchestration.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`worker:thread:${NodeCrypto.randomUUID()}`),
            threadId: childThreadId,
            projectId: parentThread.projectId,
            botId,
            groupId: null,
            parentThreadId: spec.parentThreadId,
            parentDelegationId: null,
            title: spec.title,
            modelSelection: parentThread.modelSelection,
            runtimeMode: parentThread.runtimeMode,
            interactionMode: "default",
            branch: parentThread.branch,
            worktreePath: parentThread.worktreePath,
            createdAt: nowIso(),
          });
          return childThreadId;
        }),
      messageChild: (childThreadId, text) =>
        workerCall(async (orchestration) => {
          const runtimeMode = deps.workerTurnDefaults.get(String(childThreadId));
          if (!runtimeMode) throw new Error(`Worker chat '${childThreadId}' is not known.`);
          await orchestration.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`worker:turn:${NodeCrypto.randomUUID()}`),
            threadId: childThreadId,
            message: {
              messageId: MessageId.make(`worker-message-${NodeCrypto.randomUUID()}`),
              role: "user",
              text,
              attachments: [],
            },
            runtimeMode,
            interactionMode: "default",
            createdAt: nowIso(),
          });
        }),
      interruptChild: (childThreadId) =>
        workerCall((orchestration) =>
          orchestration.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`worker:interrupt:${NodeCrypto.randomUUID()}`),
            threadId: childThreadId,
            createdAt: nowIso(),
          }),
        ).pipe(Effect.ignoreCause({ log: true })),
      discardChild: (childThreadId) =>
        Effect.sync(() => deps.workerTurnDefaults.delete(String(childThreadId))).pipe(
          Effect.andThen(
            workerCall((orchestration) =>
              orchestration.dispatch({
                type: "thread.delete",
                commandId: CommandId.make(`worker:discard:${NodeCrypto.randomUUID()}`),
                threadId: childThreadId,
              }),
            ),
          ),
          Effect.ignoreCause({ log: true }),
        ),
    });
    const workersFor = (
      threadId: ThreadId,
      access: AkeruDelegationAccessGrant,
    ): NonNullable<AkeruToolSession["workers"]> => {
      const parent = () => {
        const turnId = deps.sessions.get(String(threadId))?.activeTurn?.turnId;
        if (!turnId) throw new Error("Workers require an active turn.");
        return { threadId, turnId, depth: workerRuntime.depthForThread(threadId), access };
      };
      return {
        depth: workerRuntime.depthForThread(threadId),
        spawn: (request) => deps.runPromise(workerRuntime.spawn(parent(), request)),
        check: (request) => deps.runPromise(workerRuntime.check({ threadId }, request)),
        message: (request) => deps.runPromise(workerRuntime.message({ threadId }, request)),
        stop: (request) => deps.runPromise(workerRuntime.stop({ threadId }, request)),
      };
    };
    return { workerCall, workerRuntime, workersFor };
  });
}
