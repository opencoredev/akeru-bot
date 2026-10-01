import { KeybindingRule, KeybindingsConfig } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

import * as ServerConfig from "./config.ts";

import * as Keybindings from "./keybindings.ts";

import { KeybindingsConfigError } from "@akeru/contracts";

export const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);

export const encodeKeybindingsConfigJson = Schema.encodeEffect(KeybindingsConfigJson);

export const decodeKeybindingsConfigJson = Schema.decodeUnknownEffect(KeybindingsConfigJson);

export const encodeResolvedKeybindingFromConfig = Schema.encodeEffect(
  Keybindings.ResolvedKeybindingFromConfig,
);

export const decodeResolvedKeybindingFromConfigExit = Schema.decodeUnknownExit(
  Keybindings.ResolvedKeybindingFromConfig,
);

export const makeKeybindingsLayer = () => {
  return Keybindings.layer.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-keybindings-test-",
        }),
      ),
    ),
  );
};

export const toDetailResult = <A, R>(effect: Effect.Effect<A, KeybindingsConfigError, R>) =>
  effect.pipe(
    Effect.mapError((error) => error.detail),
    Effect.result,
  );

export const writeKeybindingsConfig = (configPath: string, rules: readonly KeybindingRule[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* encodeKeybindingsConfigJson(rules);
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, encoded);
  });

export const readKeybindingsConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rawConfig = yield* fileSystem.readFileString(configPath);

    return yield* decodeKeybindingsConfigJson(rawConfig);
  });
