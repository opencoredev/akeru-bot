import * as Effect from "effect/Effect";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
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
    changed: ReadonlySet<string>,
    instances: Readonly<Record<string, ProviderInstanceConfig>>,
  ) =>
    BRIDGE_PROVIDERS.some(
      ({ provider, driver }) =>
        driver === session.provider &&
        changed.has(`${provider}:${sessionInstanceId(session)}`) &&
        instanceUsesSavedCredential(provider, instances[sessionInstanceId(session)]),
    );

  return Effect.fn("subscriptionAuth.resetChangedApiKeySessions")(function* <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) {
    const instances = yield* loadInstances;
    // Default instances run even when settings do not list them.
    const bindings = [
      ...BRIDGE_PROVIDERS.filter(
        ({ driver }) =>
          !Object.hasOwn(instances, defaultInstanceIdForDriver(ProviderDriverKind.make(driver))),
      ).map(({ provider, driver }) => ({
        provider,
        instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make(driver)) as string,
      })),
      ...Object.entries(instances).flatMap(([instanceId, instance]) => {
        const match = BRIDGE_PROVIDERS.find(({ driver }) => driver === instance.driver);
        return match ? [{ provider: match.provider, instanceId }] : [];
      }),
    ];
    const before = bindings.map(({ provider, instanceId }) =>
      auth.getApiKeyCredential(provider, instanceId),
    );
    const result = yield* operation;
    const changed = new Set(
      bindings.flatMap(({ provider, instanceId }, index) => {
        const previous = before[index];
        const current = auth.getApiKeyCredential(provider, instanceId);
        return previous?.access !== current?.access || previous?.baseUrl !== current?.baseUrl
          ? [`${provider}:${instanceId}`]
          : [];
      }),
    );
    if (changed.size === 0) return result;

    const sessions = yield* controller.listSessions();
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
