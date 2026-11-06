import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  SubscriptionCredentialStoreError,
  type SubscriptionAuthData,
  type SubscriptionCredentialStore,
} from "./credentialStore.ts";
import type { SubscriptionHealthService } from "./healthService.ts";
import {
  credentialAt,
  retiredCredentialAt,
  retiredLoginKeys,
  retiredLoginMarkerKey,
  withoutRetiredLogins,
  type ProviderHealthData,
} from "./serviceTypes.ts";

/**
 * Deletes Claude Pro and Max logins saved by older versions, so their tokens leave the disk.
 * The guidance marker is written first: losing it after the tokens are gone would leave a bare
 * "not connected" row with no reason. A failure is logged and leaves the logins ignored.
 */
export function removeRetiredLogins(
  store: SubscriptionCredentialStore,
  healthService: SubscriptionHealthService,
  clock: Clock.Clock,
): Effect.Effect<void> {
  const keys = retiredLoginKeys(store.current().data);

  if (keys.length === 0) return Effect.void;

  return Effect.try({
    try: () => {
      const at = DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
      healthService.reloadHealth();

      for (const key of keys) {
        const marker = retiredLoginMarkerKey(key);
        healthService.health[marker] = {
          ...healthService.health[marker],
          retiredLoginRemovedAt: at,
        };
      }

      healthService.saveHealth();
    },
    catch: (cause) =>
      new SubscriptionCredentialStoreError({
        reason: "write",
        path: healthService.healthPath,
        detail: String(cause),
      }),
  }).pipe(
    // Delete only the logins whose marker was just saved. One another process adds meanwhile
    // stays ignored and is removed, with its marker, on the next start.
    Effect.andThen(store.update((data) => withoutRetiredLogins(data, new Set(keys)))),
    Effect.asVoid,
    Effect.catch((error) => Effect.logWarning("could not remove retired Claude logins", { error })),
  );
}

/** True while a scope has no usable credential but had, or still has, a retired Claude login. */
export function hasRetiredLoginAt(
  data: SubscriptionAuthData,
  health: ProviderHealthData,
  key: string,
): boolean {
  return (
    credentialAt(data, key) === undefined &&
    (retiredCredentialAt(data, key) || health[key]?.retiredLoginRemovedAt !== undefined)
  );
}
