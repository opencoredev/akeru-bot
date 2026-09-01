import { EnvironmentId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
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
import { createMemoryEnvironmentAtoms } from "./memory.ts";

const environmentId = EnvironmentId.make("memory-environment");

it.effect("routes memory commands and refreshes inspection after changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = {
        [WS_METHODS.memoryExport]: () =>
          Effect.sync(() => calls.push(WS_METHODS.memoryExport)).pipe(
            Effect.as({ schemaVersion: 2 } as never),
          ),
        [WS_METHODS.memoryMutate]: () =>
          Effect.sync(() => calls.push(WS_METHODS.memoryMutate)).pipe(
            Effect.as({ kind: "conversation-cleared" } as never),
          ),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Memory environment",
          httpBaseUrl: "https://memory.example.test",
          wsBaseUrl: "wss://memory.example.test",
        }),
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
      const atoms = createMemoryEnvironmentAtoms(
        Atom.runtime(
          Layer.succeed(
            EnvironmentRegistry.EnvironmentRegistry,
            EnvironmentRegistry.EnvironmentRegistry.of({
              run,
            } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
          ),
        ),
      );
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
        Effect.sync(() => value.dispose()),
      );
      const refresh = vi.spyOn(registry, "refresh");
      const threadId = ThreadId.make("thread-memory");

      const exported = yield* Effect.promise(() =>
        atoms.exportArchive.run(registry, {
          environmentId,
          input: { threadId, target: "thread", complete: true },
        }),
      );
      const mutated = yield* Effect.promise(() =>
        atoms.mutate.run(registry, {
          environmentId,
          input: { threadId, mutation: { operation: "conversation.clear" } },
        }),
      );

      expect(AsyncResult.isSuccess(exported)).toBe(true);
      expect(AsyncResult.isSuccess(mutated)).toBe(true);
      expect(calls).toEqual([WS_METHODS.memoryExport, WS_METHODS.memoryMutate]);
      expect(refresh).toHaveBeenCalledWith(
        atoms.inspect({
          environmentId,
          input: { threadId },
        }),
      );
    }),
  ),
);
