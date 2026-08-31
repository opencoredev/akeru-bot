import { BotId, EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
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
});
