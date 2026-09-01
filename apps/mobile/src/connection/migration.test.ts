import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { migrateLegacyConnectionCatalog } from "./migration";

describe("migrateLegacyConnectionCatalog", () => {
  it.effect("migrates bearer connections and drops hosted relay records", () =>
    Effect.gen(function* () {
      const bearerEnvironmentId = EnvironmentId.make("bearer-environment");
      const relayEnvironmentId = EnvironmentId.make("relay-environment");
      const catalog = yield* migrateLegacyConnectionCatalog(
        JSON.stringify({
          connections: [
            {
              environmentId: bearerEnvironmentId,
              environmentLabel: "Local Mac",
              pairingUrl: "https://local.example.test/pair",
              displayUrl: "https://local.example.test",
              httpBaseUrl: "https://local.example.test",
              wsBaseUrl: "wss://local.example.test",
              bearerToken: "bearer-token",
              authenticationMethod: "bearer",
            },
            {
              environmentId: relayEnvironmentId,
              environmentLabel: "Cloud Mac",
              pairingUrl: "https://relay.example.test",
              displayUrl: "https://relay.example.test",
              httpBaseUrl: "https://relay.example.test",
              wsBaseUrl: "wss://relay.example.test",
              bearerToken: null,
              authenticationMethod: "dpop",
              relayManaged: true,
            },
          ],
        }),
      );

      expect(catalog.targets).toHaveLength(1);
      expect(
        catalog.targets.find((target) => target.environmentId === bearerEnvironmentId)?._tag,
      ).toBe("BearerConnectionTarget");
      expect(catalog.targets.some((target) => target.environmentId === relayEnvironmentId)).toBe(
        false,
      );
      expect(catalog.profiles).toHaveLength(1);
      expect(catalog.credentials).toHaveLength(1);
      expect(catalog.credentials[0]?.credential).toMatchObject({
        _tag: "BearerConnectionCredential",
        token: "bearer-token",
      });
    }),
  );

  it.effect("drops invalid legacy bearer entries without credentials", () =>
    Effect.gen(function* () {
      const catalog = yield* migrateLegacyConnectionCatalog(
        JSON.stringify({
          connections: [
            {
              environmentId: EnvironmentId.make("invalid-bearer"),
              environmentLabel: "Invalid",
              pairingUrl: "https://invalid.example.test/pair",
              displayUrl: "https://invalid.example.test",
              httpBaseUrl: "https://invalid.example.test",
              wsBaseUrl: "wss://invalid.example.test",
              bearerToken: null,
              authenticationMethod: "bearer",
            },
          ],
        }),
      );

      expect(catalog.targets).toEqual([]);
    }),
  );
});
