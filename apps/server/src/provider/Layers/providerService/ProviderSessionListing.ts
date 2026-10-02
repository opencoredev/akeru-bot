import { type ProviderInstanceId, type ProviderSession, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type ProviderAdapterError } from "../../Errors.ts";
import type { ProviderAdapterShape } from "../../Services/ProviderAdapter.ts";
import * as ProviderSessionDirectory from "../../Services/ProviderSessionDirectory.ts";
import {
  type ProviderServiceMethod,
  dieOnMissingBindingInstanceId,
} from "./ProviderSessionMapping.ts";

/**
 * Lists live adapter sessions, overlaying the persisted binding's resume
 * cursor, runtime mode, and instance id for each active thread.
 */
export function createProviderSessionListing(deps: {
  readonly directory: ProviderSessionDirectory.ProviderSessionDirectoryShape;
  readonly getAdapterEntries: Effect.Effect<
    [ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>][],
    never,
    never
  >;
}) {
  const { directory, getAdapterEntries } = deps;

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;

      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );

      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);

      // Only live adapter sessions appear in this response. Resolving every
      // historical binding here makes each call scale with the full thread
      // history instead of the active session set.
      const persistedBindings = yield* Effect.forEach(
        [...new Set(activeSessions.map((session) => session.threadId))],
        (threadId) =>
          directory
            .getBinding(threadId)
            .pipe(
              Effect.orElseSucceed(() =>
                Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
              ),
            ),
        { concurrency: "unbounded" },
      ).pipe(Effect.orElseSucceed(() => []));

      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();

      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);

        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];

      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);

        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          -readonly [Key in
            | "resumeCursor"
            | "runtimeMode"
            | "providerInstanceId"]?: ProviderSession[Key];
        } = {};

        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );

        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }

        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }

        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }

        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }

        sessions.push(Object.assign({}, session, overrides));
      }

      return sessions;
    },
  );

  return listSessions;
}
