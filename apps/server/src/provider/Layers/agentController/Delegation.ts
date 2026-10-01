import type { AkeruRuntimeSeam } from "../../AkeruRuntimeSeam.ts";
import type { AgentControllerLiveOptions } from "./Options.ts";
// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type BotId,
  type ProviderRuntimeEvent,
  ThreadId,
  type AkeruDelegationAccessGrant,
  type AkeruDelegationRecord,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@akeru/contracts";

import * as Clock from "effect/Clock";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { type AkeruChannelRuntime } from "../../AkeruChannelRuntime.ts";
import { type AkeruBotStateRuntime } from "../../AkeruBotStateRuntime.ts";

import {
  createAkeruDelegationRuntime,
  type AkeruDelegationChildOutcome,
} from "../../AkeruDelegationRuntime.ts";

import { AKERU_CHILD_WAIT_DEFAULT_TIMEOUT, makePendingWaiters } from "../../PendingWaiters.ts";
import {
  createAkeruPluginRuntime,
  type AkeruPluginRuntimeOptions,
} from "../../AkeruCatalogToolHandlers.ts";

import { type AkeruToolSession } from "../../AkeruToolRuntime.ts";

import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";

import { type ActiveSession, type WorkerOrchestration } from "./State.ts";
import { delegatedUsageReceipt } from "./ProviderAccess.ts";
import { nowIso } from "./EventIdentity.ts";

export function createDelegation(deps: {
  readonly runPromise: AkeruRuntimeSeam["runPromise"];
  readonly fork: AkeruRuntimeSeam["fork"];
  readonly wired: () => {
    readonly channelRuntime?: AkeruChannelRuntime;
    readonly pluginRuntime?: ReturnType<typeof createAkeruPluginRuntime>;
    readonly pluginRuntimeOptions?: AkeruPluginRuntimeOptions;
    readonly botStateRuntime?: AkeruBotStateRuntime;
    readonly delegationRuntime?: AgentControllerLiveOptions["delegationRuntime"];
    readonly workerOrchestration?: WorkerOrchestration;
  };
  readonly sessions: Map<string, ActiveSession>;
  readonly childWaiters: ReturnType<
    typeof makePendingWaiters<null, AkeruDelegationChildOutcome>
  > extends Effect.Effect<infer A, infer _E, infer _R>
    ? A
    : never;
  readonly legacyProviderBridge: LegacyProviderBridge["Service"];
  readonly publish: (event: ProviderRuntimeEvent) => void;
  readonly failureDetail: (cause: unknown) => string;
}) {
  const delegationFor = (input: {
    readonly threadId: ThreadId;
    readonly botId: BotId;
    readonly parentDelegation: AkeruDelegationRecord | undefined;
    readonly access: AkeruDelegationAccessGrant;
    readonly activeChildDelegations: number;
  }): NonNullable<AkeruToolSession["delegation"]> => {
    const delegationRuntime = deps.wired().delegationRuntime;

    const parent = () => {
      const turnId = deps.sessions.get(String(input.threadId))?.activeTurn?.turnId;

      if (!turnId || !delegationRuntime) {
        throw new Error("Bot management requires an active parent turn.");
      }

      return {
        threadId: input.threadId,
        turnId,
        botId: input.botId,
        parentDelegationId: input.parentDelegation?.delegationId ?? null,
        ancestorBotIds: input.parentDelegation?.ancestorBotIds ?? [],
        depth: input.parentDelegation?.depth ?? 0,
        access: input.access,
      };
    };

    const createAgent = delegationRuntime?.create;
    const checkAgent = delegationRuntime?.check;
    const stopAgent = delegationRuntime?.stop;

    return {
      depth: input.parentDelegation?.depth ?? 0,
      activeDelegations: input.activeChildDelegations,
      access: input.access,
      ...(createAgent ? { create: (request) => createAgent(parent(), request) } : {}),
      ...(checkAgent ? { check: (request) => checkAgent(parent(), request) } : {}),
      send: (request) => delegationRuntime!.send(parent(), request),
      ...(stopAgent ? { stop: (request) => stopAgent(parent(), request) } : {}),
    };
  };

  const makeDelegationRuntime = (input: {
    readonly readSnapshot: () => Promise<OrchestrationReadModel>;
    readonly dispatch: (command: OrchestrationCommand) => Promise<unknown>;
  }) =>
    createAkeruDelegationRuntime({
      ...input,
      dispatch: async (command) => {
        await input.dispatch(command);
      },
      awaitChild: (threadId, deadline) =>
        deps.runPromise(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;

            return yield* deps.childWaiters.wait(
              String(threadId),
              null,
              deadline === null
                ? {
                    timeout: AKERU_CHILD_WAIT_DEFAULT_TIMEOUT,
                    timeoutMessage: `The bot did not report back within ${Duration.toHours(AKERU_CHILD_WAIT_DEFAULT_TIMEOUT)} hours.`,
                    existsMessage: `Delegation waiter already exists for '${threadId}'.`,
                  }
                : {
                    timeout: Duration.millis(Date.parse(deadline) - now),
                    timeoutMessage: "The delegation deadline expired.",
                    existsMessage: `Delegation waiter already exists for '${threadId}'.`,
                  },
            );
          }),
        ),
      interruptChild: (threadId, turnId) =>
        input
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`delegation:interrupt:${NodeCrypto.randomUUID()}`),
            threadId,
            ...(turnId ? { turnId } : {}),
            createdAt: nowIso(),
          })
          .then(() => undefined),
      providerDriverKind: (instanceId) =>
        deps.runPromise(
          deps.legacyProviderBridge.getInstanceInfo(instanceId).pipe(
            Effect.map((routing): string | null => routing.driverKind),
            Effect.orElseSucceed(() => null),
          ),
        ),
      recordUsage: async (usage) => {
        const active = deps.sessions.get(String(usage.threadId));

        if (active) deps.publish(delegatedUsageReceipt(usage, active));
      },
      onWatchError: (delegationId, cause) =>
        deps.fork(
          "Akeru delegated work could not record its outcome.",
          Effect.fail(deps.failureDetail(cause)),
          { delegationId },
        ),
      onGroupResultSkipped: (delegationId, reason) =>
        deps.fork(
          "Akeru could not log a skipped group result.",
          Effect.logInfo("delegated result not posted to the group chat", {
            delegationId,
            reason,
          }),
        ),
    });

  return { delegationFor, makeDelegationRuntime };
}
