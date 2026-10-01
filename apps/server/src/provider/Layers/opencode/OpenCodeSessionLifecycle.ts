import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { OpenCodeRuntimeError, runOpenCodeSdk } from "../../opencodeRuntime.ts";

import { isOpenCodeNotFound } from "./OpenCodeProtocol.ts";
import { type OpenCodeSessionContext } from "./OpenCodeAdapterState.ts";

export const abortOpenCodeDescendants = Effect.fn("abortOpenCodeDescendants")(function* (
  context: OpenCodeSessionContext,
) {
  const visited = new Set([context.openCodeSessionId]);
  const requestSemaphore = Semaphore.makeUnsafe(8);

  const visit = (
    sessionId: string,
    abortSession: boolean,
  ): Effect.Effect<OpenCodeRuntimeError | undefined> =>
    Effect.gen(function* () {
      let firstFailure: OpenCodeRuntimeError | undefined;
      if (abortSession) {
        const abortResult = yield* requestSemaphore
          .withPermits(1)(
            runOpenCodeSdk("session.abort", () =>
              context.client.session.abort({ sessionID: sessionId }),
            ),
          )
          .pipe(
            Effect.catchIf(
              (cause) => isOpenCodeNotFound(cause),
              () => Effect.void,
            ),
            Effect.result,
          );
        if (abortResult._tag === "Failure") {
          firstFailure = abortResult.failure;
        }
      }

      const childrenResult = yield* requestSemaphore
        .withPermits(1)(
          runOpenCodeSdk("session.children", () =>
            context.client.session.children({ sessionID: sessionId }),
          ),
        )
        .pipe(
          Effect.catchIf(
            (cause) => isOpenCodeNotFound(cause),
            () => Effect.void,
          ),
          Effect.result,
        );
      if (childrenResult._tag === "Failure") {
        return firstFailure ?? childrenResult.failure;
      }

      const children = childrenResult.success?.data ?? [];
      const newChildren = children.filter((child) => {
        if (visited.has(child.id)) {
          return false;
        }
        visited.add(child.id);
        return true;
      });
      const childFailures = yield* Effect.forEach(newChildren, (child) => visit(child.id, true), {
        concurrency: 8,
      });
      firstFailure ??= childFailures.find((failure) => failure !== undefined);
      return firstFailure;
    });

  const firstFailure = yield* visit(context.openCodeSessionId, false);
  if (firstFailure) {
    return yield* firstFailure;
  }
});

export const abortOpenCodeSessionForTeardown = Effect.fn("abortOpenCodeSessionForTeardown")(
  function* (context: OpenCodeSessionContext) {
    // Stop the parent before the snapshot so it cannot add another child after
    // the adapter reads the tree.
    yield* runOpenCodeSdk("session.abort", () =>
      context.client.session.abort({ sessionID: context.openCodeSessionId }),
    ).pipe(Effect.timeout("1 second"), Effect.ignore({ log: true }));
    yield* abortOpenCodeDescendants(context).pipe(
      Effect.timeout("1 second"),
      Effect.ignore({ log: true }),
    );
  },
);

export const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }

  // Best-effort remote abort. The scope close below tears down the local
  // handles (event-pump fiber, server-exit fiber, event-subscribe fetch),
  // but we still want to tell OpenCode that this session is done, including
  // every descendant subagent session.
  yield* abortOpenCodeSessionForTeardown(context);

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered — the `AbortController.abort()` call,
  // the child-process termination, etc.
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});
