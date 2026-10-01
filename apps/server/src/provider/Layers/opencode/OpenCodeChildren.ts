import * as Effect from "effect/Effect";
import { OpenCodeRuntimeError, runOpenCodeSdk } from "../../opencodeRuntime.ts";
import { type OpenCodeSessionContext } from "./OpenCodeAdapterState.ts";
import { isOpenCodeNotFound } from "./OpenCodeProtocol.ts";

export const addRelatedOpenCodeSession = (context: OpenCodeSessionContext, sessionId: string) => {
  context.relatedSessionIds.add(sessionId);
};

export const isRelatedOpenCodeSession = Effect.fn("isRelatedOpenCodeSession")(function* (
  context: OpenCodeSessionContext,
  candidateSessionId: string,
) {
  if (context.relatedSessionIds.has(candidateSessionId)) {
    return true;
  }

  const seen = new Set<string>();

  const getSession = (sessionID: string) =>
    runOpenCodeSdk("session.get", () => context.client.session.get({ sessionID })).pipe(
      Effect.catchIf(
        (cause) => isOpenCodeNotFound(cause),
        () => Effect.succeed(undefined),
      ),
    );

  let sessionId: string | undefined = candidateSessionId;

  for (let depth = 0; sessionId !== undefined && depth < 32; depth += 1) {
    if (context.relatedSessionIds.has(sessionId)) {
      addRelatedOpenCodeSession(context, candidateSessionId);

      return true;
    }

    if (seen.has(sessionId)) {
      return false;
    }

    seen.add(sessionId);
    const currentSessionId: string = sessionId;
    const response = yield* getSession(currentSessionId);

    if (response === undefined) {
      return false;
    }

    if (!response.data) {
      return yield* new OpenCodeRuntimeError({
        operation: "session.get",
        detail: `OpenCode session.get returned no session payload for '${currentSessionId}'.`,
      });
    }

    sessionId = response.data.parentID;
  }

  return false;
});
