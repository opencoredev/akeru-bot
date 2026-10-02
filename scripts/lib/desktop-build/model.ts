import * as Effect from "effect/Effect";

import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

export const DESKTOP_PACKAGE_NAME = "akeru-bot";

export const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);

export const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);

export const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

export const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
