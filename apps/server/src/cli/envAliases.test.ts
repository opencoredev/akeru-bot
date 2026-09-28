import { describe, expect, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { aliasedEnv, readAliasedEnv } from "./envAliases.ts";

const readPort = (env: Record<string, string>) =>
  aliasedEnv(Config.port, "PORT")
    .parse(ConfigProvider.fromEnv({ env }))
    .pipe(Effect.map(Option.getOrUndefined));

describe("aliasedEnv", () => {
  it.effect("reads the AKERU_ name", () =>
    Effect.gen(function* () {
      expect(yield* readPort({ AKERU_PORT: "4100" })).toBe(4100);
    }),
  );

  it.effect("falls back to the legacy T3CODE_ name", () =>
    Effect.gen(function* () {
      expect(yield* readPort({ T3CODE_PORT: "4200" })).toBe(4200);
    }),
  );

  it.effect("prefers the AKERU_ name when both are set", () =>
    Effect.gen(function* () {
      expect(yield* readPort({ AKERU_PORT: "4100", T3CODE_PORT: "4200" })).toBe(4100);
    }),
  );

  it.effect("reports a missing value as none", () =>
    Effect.gen(function* () {
      expect(yield* readPort({})).toBeUndefined();
    }),
  );
});

describe("readAliasedEnv", () => {
  it("prefers AKERU_ and falls back to T3CODE_", () => {
    expect(readAliasedEnv({ AKERU_HOME: "/a", T3CODE_HOME: "/b" }, "HOME")).toBe("/a");
    expect(readAliasedEnv({ T3CODE_HOME: "/b" }, "HOME")).toBe("/b");
    expect(readAliasedEnv({ AKERU_HOME: "  ", T3CODE_HOME: "/b" }, "HOME")).toBe("/b");
    expect(readAliasedEnv({}, "HOME")).toBeUndefined();
  });
});
