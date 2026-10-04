import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { AnyProviderDriver, ProviderDriver } from "./ProviderDriver.ts";

/** Decode once and retain the config type inside the instance-construction closure. */
export function registeredProviderDriver<Config, R>(
  driver: ProviderDriver<Config, R>,
): AnyProviderDriver<R> {
  const decodeConfig = Schema.decodeUnknownEffect(driver.configSchema);

  return {
    driverKind: driver.driverKind,
    metadata: driver.metadata,
    prepare: (rawConfig) =>
      decodeConfig(rawConfig ?? driver.defaultConfig()).pipe(
        Effect.map((config) => ({
          config,
          create: (input) => driver.create({ ...input, config }),
        })),
      ),
  };
}
