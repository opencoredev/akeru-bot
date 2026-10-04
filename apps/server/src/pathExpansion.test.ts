import * as NodePathService from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { expandHomePath } from "./pathExpansion.ts";

describe("expandHomePath", () => {
  it.effect("returns an empty string unchanged", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(expandHomePath("", path)).toBe("");
    }).pipe(Effect.provide(NodePathService.layer)),
  );

  it.effect("returns paths without a leading tilde unchanged", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(expandHomePath("/absolute/path", path)).toBe("/absolute/path");
      expect(expandHomePath("relative/path", path)).toBe("relative/path");
      expect(expandHomePath("some~weird~path", path)).toBe("some~weird~path");
    }).pipe(Effect.provide(NodePathService.layer)),
  );

  it.effect("expands a lone tilde to the home directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(expandHomePath("~", path)).toBe(NodeOS.homedir());
    }).pipe(Effect.provide(NodePathService.layer)),
  );

  it.effect("expands ~/ to a subpath of the home directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(expandHomePath("~/.codex-work", path)).toBe(
        NodePath.join(NodeOS.homedir(), ".codex-work"),
      );
    }).pipe(Effect.provide(NodePathService.layer)),
  );

  it.effect("expands a Windows-style ~\\ prefix", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(expandHomePath("~\\.codex", path)).toBe(NodePath.join(NodeOS.homedir(), ".codex"));
    }).pipe(Effect.provide(NodePathService.layer)),
  );

  it.effect("does not expand ~user paths", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(expandHomePath("~alice/foo", path)).toBe("~alice/foo");
    }).pipe(Effect.provide(NodePathService.layer)),
  );
});
