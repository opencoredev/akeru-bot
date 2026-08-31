// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { KimiDriver } from "./KimiDriver.ts";

describe("KimiDriver", () => {
  it.effect("registers one Mastra-native Kimi provider with offline model metadata", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind))).toContain("kimi");
    const program = Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* KimiDriver.create({
          instanceId: ProviderInstanceId.make("kimi"),
          displayName: undefined,
          environment: [],
          enabled: true,
          config: KimiDriver.defaultConfig(),
        });
        const snapshot = yield* instance.snapshot.getSnapshot;
        return { instance, snapshot };
      }),
    );
    return program.pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-kimi-driver-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.instance.adapter).toBeUndefined();
          expect(result.instance.textGeneration).toBeUndefined();
          expect(result.snapshot).toMatchObject({
            instanceId: "kimi",
            driver: "kimi",
            displayName: "Kimi For Coding",
            installed: true,
            auth: { status: "unauthenticated", type: "oauth" },
            models: expect.arrayContaining([
              expect.objectContaining({ slug: "k3" }),
              expect.objectContaining({ slug: "k3-256k" }),
            ]),
          });
        }),
      ),
    );
  });

  it.effect("refreshes the snapshot after subscription auth changes", () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const instance = yield* KimiDriver.create({
          instanceId: ProviderInstanceId.make("kimi"),
          displayName: undefined,
          environment: [],
          enabled: true,
          config: KimiDriver.defaultConfig(),
        });
        const before = yield* instance.snapshot.getSnapshot;
        NodeFS.mkdirSync(config.secretsDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(config.secretsDir, "subscription-auth.json"),
          JSON.stringify({
            "kimi-for-coding": {
              type: "oauth",
              access: "offline-test-token",
              refresh: "offline-test-refresh",
              expires: 4_102_444_800_000,
              deviceId: "0123456789abcdef0123456789abcdef",
            },
          }),
        );
        const after = yield* instance.snapshot.refresh;
        return { before, after, continuationIdentity: instance.continuationIdentity };
      }),
    );
    return program.pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-kimi-refresh-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.before.auth.status).toBe("unauthenticated");
          expect(result.after.auth.status).toBe("authenticated");
          expect(result.after.status).toBe("ready");
          expect(result.after.continuation?.groupKey).toBe(
            result.continuationIdentity.continuationKey,
          );
        }),
      ),
    );
  });
});
