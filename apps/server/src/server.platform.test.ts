import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import * as ServerConfig from "./config.ts";
import { selectHttpServerLayer, PlatformServicesLive } from "./server.ts";

beforeEach(() => {
  vi.stubGlobal("Bun", undefined);
  Reflect.deleteProperty(globalThis, "Bun");
  expect("Bun" in globalThis).toBe(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it.effect("selects the Node HTTP layer when the Bun global is absent", () =>
  Effect.gen(function* () {
    const layer = yield* selectHttpServerLayer;

    expect(Layer.isLayer(layer)).toBe(true);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest("/tmp", { prefix: "akeru-platform-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("selects working Node platform services when the Bun global is absent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(import.meta.filename);

    expect(exists).toBe(true);
  }).pipe(Effect.provide(PlatformServicesLive)),
);
