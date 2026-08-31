import { BotId, EnvironmentId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { vi } from "vite-plus/test";

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
import { createMemoryEnvironmentAtoms } from "./memory.ts";

const environmentId = EnvironmentId.make("memory-usage-environment");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Memory and usage",
  httpBaseUrl: "https://example.test",
  wsBaseUrl: "wss://example.test",
});

const runtimeFor = Effect.fn("memoryAndBotUsage.runtimeFor")(function* (
  client: WsRpcProtocolClient,
) {
  const session: RpcSession = {
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
    session: yield* SubscriptionRef.make(Option.some(session)),
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
  const stateChanges: EnvironmentRegistry.EnvironmentRegistry["Service"]["stateChanges"] = () =>
    SubscriptionRef.changes(supervisor.state);
  const service = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  return Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, service));
});

describe("memory and bot usage environment atoms", () => {
  it.effect("routes memory inspection and refreshes it after a mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-memory");
        let resolveInspect!: () => void;
        const inspected = new Promise<void>((resolve) => {
          resolveInspect = resolve;
        });
        const client = {
          [WS_METHODS.memoryInspect]: () =>
            Effect.sync(() => {
              resolveInspect();
              return {
                threadId,
                durable: [],
                histories: [],
                pending: [],
                conversation: { current: null, history: [] },
              } as never;
            }),
          [WS_METHODS.memoryMutate]: () =>
            Effect.succeed({ kind: "conversation-cleared" } as never),
        } as unknown as WsRpcProtocolClient;
        const atoms = createMemoryEnvironmentAtoms(yield* runtimeFor(client));
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
          Effect.sync(() => value.dispose()),
        );
        const input = { environmentId, input: { threadId } };
        const inspectAtom = atoms.inspect(input);
        const refresh = vi.spyOn(registry, "refresh");
        const unmount = registry.mount(inspectAtom);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        yield* Effect.promise(() => inspected);

        const result = yield* Effect.promise(() =>
          atoms.mutate.run(registry, {
            environmentId,
            input: { threadId, mutation: { operation: "conversation.clear" } },
          }),
        );
        expect(AsyncResult.isSuccess(result)).toBe(true);
        expect(refresh.mock.calls.some(([atom]) => atom === inspectAtom)).toBe(true);
      }),
    ),
  );

  it.effect("keys bot usage by environment and bot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const botId = BotId.make("bot-usage");
        let requestedBotId: BotId | undefined;
        let resolveUsage!: () => void;
        const requested = new Promise<void>((resolve) => {
          resolveUsage = resolve;
        });
        const client = {
          [WS_METHODS.botUsage]: (input: { readonly botId: BotId }) =>
            Effect.sync(() => {
              requestedBotId = input.botId;
              resolveUsage();
              return {} as never;
            }),
        } as unknown as WsRpcProtocolClient;
        const atoms = createBotUsageEnvironmentAtoms(yield* runtimeFor(client));
        const atom = atoms.summary({ environmentId, input: { botId } });
        expect(atom).toBe(atoms.summary({ environmentId, input: { botId } }));
        expect(atom).not.toBe(
          atoms.summary({ environmentId, input: { botId: BotId.make("other-bot") } }),
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
