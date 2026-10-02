import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as ModelCatalog from "../ModelCatalog.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { BUNDLED_MODEL_CATALOG } from "../modelCatalogData.ts";
import { KimiDriver } from "./KimiDriver.ts";

describe("KimiDriver", () => {
  it.effect("registers one Mastra-native Kimi provider with offline model metadata", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind))).toContain("kimi");
    expect(BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind))).not.toContain("cursor");

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
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(ModelCatalog.layerTest),
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
            // Kimi For Coding has no skill-loading mechanism, so the catalog
            // is intentionally empty rather than silently missing.
            skills: [],
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
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(ModelCatalog.layerTest),
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
  it.effect("republishes its snapshot when the model catalog changes", () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const catalogRef = yield* Ref.make(BUNDLED_MODEL_CATALOG);
        const catalogChanges = yield* PubSub.unbounded<typeof BUNDLED_MODEL_CATALOG>();

        const instance = yield* KimiDriver.create({
          instanceId: ProviderInstanceId.make("kimi"),
          displayName: undefined,
          environment: [],
          enabled: true,
          config: KimiDriver.defaultConfig(),
        }).pipe(
          Effect.provideService(ModelCatalog.ModelCatalog, {
            current: Ref.get(catalogRef),
            refresh: Ref.get(catalogRef),
            refreshInBackground: Effect.void,
            changes: Stream.fromPubSub(catalogChanges),
          }),
        );

        const published = yield* Stream.runHead(instance.snapshot.streamChanges).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );

        const next = {
          ...BUNDLED_MODEL_CATALOG,
          drivers: { ...BUNDLED_MODEL_CATALOG.drivers, kimi: [{ id: "k9", name: "Kimi K9" }] },
        };

        yield* Ref.set(catalogRef, next);
        yield* PubSub.publish(catalogChanges, next);

        return yield* Fiber.join(published);
      }),
    );

    return program.pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-kimi-catalog-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot._tag).toBe("Some");
          expect(Option.getOrThrow(snapshot).models).toContainEqual(
            expect.objectContaining({ slug: "k9", name: "Kimi K9" }),
          );
        }),
      ),
    );
  });
});
