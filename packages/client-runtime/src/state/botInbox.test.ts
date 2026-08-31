import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
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
import { createBotInboxEnvironmentAtoms } from "./botInbox.ts";

const environmentId = EnvironmentId.make("inbox-environment");
const session = (client: WsRpcProtocolClient): RpcSession => ({
  client,
  initialConfig: Effect.never,
  ready: Effect.void,
  probe: Effect.void,
  closed: Effect.never,
});

it.effect("routes incident resolution and refreshes the environment inbox", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const resolved: string[] = [];
      const client = {
        [WS_METHODS.botInboxResolve]: ({ id }: { id: string }) =>
          Effect.sync(() => resolved.push(id)),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Inbox environment",
          httpBaseUrl: "https://inbox.example.test",
          wsBaseUrl: "wss://inbox.example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const atoms = createBotInboxEnvironmentAtoms(
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

      const result = yield* Effect.promise(() =>
        atoms.resolve.run(registry, {
          environmentId,
          input: { id: "incident-1" },
        }),
      );

      expect(AsyncResult.isSuccess(result)).toBe(true);
      expect(resolved).toEqual(["incident-1"]);
      expect(refresh).toHaveBeenCalledWith(atoms.list({ environmentId, input: {} }));
    }),
  ),
);
