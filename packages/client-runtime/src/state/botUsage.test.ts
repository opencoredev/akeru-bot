import { BotId, EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createBotUsageEnvironmentAtoms } from "./botUsage.ts";

const environmentId = EnvironmentId.make("usage-environment");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Usage environment",
  httpBaseUrl: "https://usage.example.test",
  wsBaseUrl: "wss://usage.example.test",
});

const snapshotFor = (botId: BotId) => ({
  botId,
  consumedTokens: 0,
  reservedTokens: 0,
  measurements: {
    input: { tokens: 0, unavailableEntries: 0 },
    output: { tokens: 0, unavailableEntries: 0 },
    observer: { tokens: 0, unavailableEntries: 0 },
    reflector: { tokens: 0, unavailableEntries: 0 },
  },
  entries: [],
  usageCap: null,
  estimatedCost: { status: "unavailable", usd: null },
  subscriptionPool: { status: "unavailable", used: null, limit: null, unit: null },
});

/**
 * A connected environment whose `bot.usage` handler counts calls, so a test can
 * assert how many reads a policy costs rather than that a read happened.
 */
const connectedEnvironment = Effect.fn(function* () {
  const calls = { count: 0 };
  const client = {
    [WS_METHODS.botUsage]: (input: { readonly botId: BotId }) =>
      Effect.sync(() => {
        calls.count += 1;
        return snapshotFor(input.botId);
      }),
  } as unknown as WsRpcProtocolClient;
  const rpcSession: RpcSession = {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(rpcSession)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const registryService = EnvironmentRegistry.EnvironmentRegistry.of({
    run: ((_id, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      )) as EnvironmentRegistry.EnvironmentRegistry["Service"]["run"],
    followStream: ((_id, stream) =>
      Stream.provideService(
        stream,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      )) as EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"],
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  return {
    calls,
    runtime: Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService)),
  };
});

const PAST_THE_OLD_POLL_INTERVAL_MS = 6_000;

describe("bot usage environment atoms", () => {
  it.effect("keys usage queries by environment and bot and calls bot.usage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let requestedBotId: BotId | undefined;
        let resolveRequest!: () => void;
        const requested = new Promise<void>((resolve) => {
          resolveRequest = resolve;
        });
        const client = {
          [WS_METHODS.botUsage]: (input: { readonly botId: BotId }) =>
            Effect.sync(() => {
              requestedBotId = input.botId;
              resolveRequest();
              return {
                botId: input.botId,
                consumedTokens: 0,
                reservedTokens: 0,
                measurements: {
                  input: { tokens: 0, unavailableEntries: 0 },
                  output: { tokens: 0, unavailableEntries: 0 },
                  observer: { tokens: 0, unavailableEntries: 0 },
                  reflector: { tokens: 0, unavailableEntries: 0 },
                },
                entries: [],
                usageCap: null,
                estimatedCost: { status: "unavailable", usd: null },
                subscriptionPool: {
                  status: "unavailable",
                  used: null,
                  limit: null,
                  unit: null,
                },
              };
            }),
        } as unknown as WsRpcProtocolClient;
        const rpcSession: RpcSession = {
          client,
          initialConfig: Effect.never,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            network: "online",
            phase: "connected",
            attempt: 1,
            generation: 1,
          }),
          session: yield* SubscriptionRef.make(Option.some(rpcSession)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
          _id,
          stream,
        ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const registryService = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
          followStream,
          stateChanges: () => SubscriptionRef.changes(supervisor.state),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const atoms = createBotUsageEnvironmentAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService)),
        );
        const botId = BotId.make("bot-usage-state");
        const atom = atoms.summary({ environmentId, input: { botId } });
        expect(atom).toBe(atoms.summary({ environmentId, input: { botId } }));
        expect(atom).not.toBe(
          atoms.summary({ environmentId, input: { botId: BotId.make("bot-usage-other") } }),
        );
        expect(atom).not.toBe(
          atoms.summary({
            environmentId: EnvironmentId.make("usage-environment-other"),
            input: { botId },
          }),
        );
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
          Effect.sync(() => value.dispose()),
        );
        const unmount = registry.mount(atom);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        yield* Effect.promise(() => requested);
        expect(requestedBotId).toBe(botId);
      }),
    ),
  );

  it.live("does not poll a mounted query while nothing signals focus", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, runtime } = yield* connectedEnvironment();
        const atoms = createBotUsageEnvironmentAtoms(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
          Effect.sync(() => value.dispose()),
        );
        vi.useFakeTimers();
        try {
          const unmount = registry.mount(
            atoms.summary({ environmentId, input: { botId: BotId.make("bot-no-poll") } }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(unmount));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20));
          expect(calls.count).toBe(1);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(PAST_THE_OLD_POLL_INTERVAL_MS));
          expect(calls.count).toBe(1);
        } finally {
          vi.useRealTimers();
        }
      }),
    ),
  );

  it.live("reads again when the client returns to the foreground", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, runtime } = yield* connectedEnvironment();
        const focusSignal = Atom.make(0);
        const atoms = createBotUsageEnvironmentAtoms(runtime, { focusSignal });
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
          Effect.sync(() => value.dispose()),
        );
        vi.useFakeTimers();
        try {
          const unmount = registry.mount(
            atoms.summary({ environmentId, input: { botId: BotId.make("bot-focus") } }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(unmount));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20));
          expect(calls.count).toBe(1);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(PAST_THE_OLD_POLL_INTERVAL_MS));
          expect(calls.count).toBe(1);
          registry.set(focusSignal, 1);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20));
          expect(calls.count).toBe(2);
        } finally {
          vi.useRealTimers();
        }
      }),
    ),
  );
});
