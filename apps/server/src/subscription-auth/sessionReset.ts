import * as Effect from "effect/Effect";
import { SubscriptionAuthError } from "@t3tools/contracts";

import type { AgentControllerShape } from "../provider/Services/AgentController.ts";
import type { SubscriptionAuthService, SubscriptionProviderId } from "./service.ts";

const BRIDGE_PROVIDERS = [
  { provider: "anthropic", driver: "claudeAgent" },
  { provider: "xai", driver: "grok" },
  { provider: "opencode-go", driver: "opencode" },
] as const satisfies ReadonlyArray<{ provider: SubscriptionProviderId; driver: string }>;

/** Restart bridge processes after their saved API credentials change. */
export function makeApiKeySessionReset(
  auth: Pick<SubscriptionAuthService, "getApiKeyCredential">,
  controller: Pick<AgentControllerShape, "listSessions" | "stopSession">,
) {
  return Effect.fn("subscriptionAuth.resetChangedApiKeySessions")(function* <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) {
    const before = BRIDGE_PROVIDERS.map(({ provider }) => auth.getApiKeyCredential(provider));
    const result = yield* operation;
    const changedDrivers = BRIDGE_PROVIDERS.filter(({ provider }, index) => {
      const previous = before[index];
      const current = auth.getApiKeyCredential(provider);
      return previous?.access !== current?.access || previous?.baseUrl !== current?.baseUrl;
    }).map(({ driver }) => driver);
    if (changedDrivers.length === 0) return result;

    const sessions = yield* controller.listSessions();
    yield* Effect.forEach(
      sessions.filter((session) => changedDrivers.some((driver) => driver === session.provider)),
      (session) => controller.stopSession({ threadId: session.threadId }),
      { discard: true },
    ).pipe(
      Effect.mapError(
        () =>
          new SubscriptionAuthError({
            reason:
              "The credentials changed, but a provider session could not stop. Stop the affected chat before retrying.",
          }),
      ),
    );
    return result;
  });
}
