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
import { OpenCodeGoDriver } from "./OpenCodeGoDriver.ts";

describe("OpenCodeGoDriver", () => {
  it.effect("registers a Mastra-native provider with OpenCode Go models", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind))).toContain("opencodeGo");
    const program = Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* OpenCodeGoDriver.create({
          instanceId: ProviderInstanceId.make("opencodeGo"),
          displayName: undefined,
          environment: [],
          enabled: true,
          config: OpenCodeGoDriver.defaultConfig(),
        });
        const snapshot = yield* instance.snapshot.getSnapshot;
        return { instance, snapshot };
      }),
    );
    return program.pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-opencode-go-driver-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.tap(({ instance, snapshot }) =>
        Effect.sync(() => {
          expect(instance.adapter).toBeUndefined();
          expect(snapshot).toMatchObject({
            instanceId: "opencodeGo",
            driver: "opencodeGo",
            displayName: "OpenCode Go",
            auth: { status: "unauthenticated", type: "apiKey" },
            models: expect.arrayContaining([
              expect.objectContaining({ slug: "gpt-5.6-luna", isDefault: true }),
              expect.objectContaining({ slug: "grok-4.5" }),
              expect.objectContaining({ slug: "muse-spark-1.3-contributor" }),
              expect.objectContaining({ slug: "qwen3.8-max" }),
            ]),
          });
        }),
      ),
    );
  });

  it.effect("refreshes after an API key is connected", () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const instance = yield* OpenCodeGoDriver.create({
          instanceId: ProviderInstanceId.make("opencodeGo"),
          displayName: undefined,
          environment: [],
          enabled: true,
          config: OpenCodeGoDriver.defaultConfig(),
        });
        NodeFS.mkdirSync(config.secretsDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(config.secretsDir, "subscription-auth.json"),
          JSON.stringify({ "opencode-go": { type: "api-key", access: "offline-test-key" } }),
        );
        return yield* instance.snapshot.refresh;
      }),
    );
    return program.pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "akeru-opencode-go-refresh-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("ready");
          expect(snapshot.auth.status).toBe("authenticated");
        }),
      ),
    );
  });
});
