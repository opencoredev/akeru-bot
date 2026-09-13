import * as Effect from "effect/Effect";
import {
  defaultInstanceIdForDriver,
  SubscriptionAuthError,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ProviderSession,
} from "@t3tools/contracts";

import type { AgentControllerShape } from "../provider/Services/AgentController.ts";
import { instanceUsesSavedCredential } from "./runtime.ts";
import type { SubscriptionAuthService, SubscriptionProviderId } from "./service.ts";

const BRIDGE_PROVIDERS = [
  { provider: "anthropic", driver: "claudeAgent" },
  { provider: "xai", driver: "grok" },
  { provider: "opencode-go", driver: "opencode" },
] as const satisfies ReadonlyArray<{ provider: SubscriptionProviderId; driver: string }>;

type BridgeProvider = (typeof BRIDGE_PROVIDERS)[number];

function sessionInstanceId(session: ProviderSession): ProviderInstanceId {
  return session.providerInstanceId ?? defaultInstanceIdForDriver(session.provider);
}

/** Restart bridge processes after their saved API credentials change. */
export function makeApiKeySessionReset(
  auth: Pick<SubscriptionAuthService, "getApiKeyCredential">,
  controller: Pick<AgentControllerShape, "listSessions" | "stopSession">,
  loadInstances: Effect.Effect<Readonly<Record<string, ProviderInstanceConfig>>>,
) {
  const usesChangedCredential = (
    session: ProviderSession,
    changed: ReadonlyArray<BridgeProvider>,
    instances: Readonly<Record<string, ProviderInstanceConfig>>,
  ) =>
    changed.some(
      ({ provider, driver }) =>
        driver === session.provider &&
        instanceUsesSavedCredential(provider, instances[sessionInstanceId(session)]),
    );

  return Effect.fn("subscriptionAuth.resetChangedApiKeySessions")(function* <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) {
    const before = BRIDGE_PROVIDERS.map(({ provider }) => auth.getApiKeyCredential(provider));
    const result = yield* operation;
    const changed = BRIDGE_PROVIDERS.filter(({ provider }, index) => {
      const previous = before[index];
      const current = auth.getApiKeyCredential(provider);
      return previous?.access !== current?.access || previous?.baseUrl !== current?.baseUrl;
    });
    if (changed.length === 0) return result;

    const [sessions, instances] = yield* Effect.all([controller.listSessions(), loadInstances]);
    yield* Effect.forEach(
      sessions.filter((session) => usesChangedCredential(session, changed, instances)),
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
