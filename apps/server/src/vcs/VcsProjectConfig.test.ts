import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as VcsProjectConfig from "./VcsProjectConfig.ts";

const TestLayer = VcsProjectConfig.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("VcsProjectConfig", () => {
  it("keeps operation context and the original cause on config errors", () => {
    const cause = new Error("permission denied");
    const akeruError = new VcsProjectConfig.VcsProjectConfigError({
      operation: "read",
      cwd: "/repo/packages/app",
      configPath: "/repo/.akeru/vcs.json",
      cause,
    });

    assert.equal(akeruError.operation, "read");
    assert.equal(akeruError.cwd, "/repo/packages/app");
    assert.equal(akeruError.configPath, "/repo/.akeru/vcs.json");
    assert.strictEqual(akeruError.cause, cause);
    assert.equal(akeruError.message, "Failed to read VCS project config at /repo/.akeru/vcs.json.");

    const t3codeError = new VcsProjectConfig.VcsProjectConfigError({
      operation: "inspect",
      cwd: "/repo/packages/app",
      configPath: "/repo/.t3code/vcs.json",
      cause,
    });
    assert.equal(
      t3codeError.message,
      "Failed to inspect VCS project config at /repo/.t3code/vcs.json.",
    );
  });

  it.layer(TestLayer)("uses an explicit requested VCS kind before config", (it) => {
    it.effect("returns the requested kind", () =>
      Effect.gen(function* () {
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({
          cwd: "/repo",
          requestedKind: "jj",
        });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("discovers .akeru/vcs.json from nested workspaces", (it) => {
    it.effect("returns the configured kind", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".akeru");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: nested });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("discovers .t3code/vcs.json from nested workspaces", (it) => {
    it.effect("returns the configured kind", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: nested });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("prefers .akeru/vcs.json over .t3code/vcs.json when both exist", (it) => {
    it.effect("returns the akeru configured kind", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const akeruConfigDir = path.join(root, ".akeru");
        const t3codeConfigDir = path.join(root, ".t3code");
        yield* fileSystem.makeDirectory(akeruConfigDir, { recursive: true });
        yield* fileSystem.makeDirectory(t3codeConfigDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(akeruConfigDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "jj" } }),
        );
        yield* fileSystem.writeFileString(
          path.join(t3codeConfigDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "git" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "jj");
      }),
    );
  });

  it.layer(TestLayer)("continues to parent configs after a candidate inspect failure", (it) => {
    it.effect("logs the failed candidate and returns the parent config", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        const cwd = path.join(root, "invalid\0child");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ vcs: { kind: "jj" } }),
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd });

        assert.equal(kind, "jj");
        const failedAkeruCandidate = path.join(cwd, ".akeru", "vcs.json");
        const failedT3codeCandidate = path.join(cwd, ".t3code", "vcs.json");
        const [akeruError] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(akeruError, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(
          akeruError.message,
          "Failed to inspect VCS project config at " + failedAkeruCandidate + ".",
        );
        assert.deepInclude(akeruError, {
          operation: "inspect",
          cwd,
          configPath: failedAkeruCandidate,
          _tag: "VcsProjectConfigError",
        });
        const [t3codeError] = messages[1] as ReadonlyArray<unknown>;
        assert.instanceOf(t3codeError, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(
          t3codeError.message,
          "Failed to inspect VCS project config at " + failedT3codeCandidate + ".",
        );
        assert.deepInclude(t3codeError, {
          operation: "inspect",
          cwd,
          configPath: failedT3codeCandidate,
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(TestLayer)("falls back to auto when no config exists", (it) => {
    it.effect("returns auto", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
      }),
    );
  });

  it.layer(TestLayer)("falls back to auto when config JSON is malformed", (it) => {
    it.effect("returns auto and logs the failed operation and path", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".akeru");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(configDir, "vcs.json"), "{not json");

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(
          error.message,
          "Failed to decode VCS project config at " + path.join(configDir, "vcs.json") + ".",
        );
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
        assert.deepInclude(error, {
          operation: "decode",
          cwd: root,
          configPath: path.join(configDir, "vcs.json"),
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(TestLayer)("falls back to auto when the config path cannot be read", (it) => {
    it.effect("retains the read failure context", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message);
      });

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configPath = path.join(root, ".t3code", "vcs.json");
        yield* fileSystem.makeDirectory(configPath, { recursive: true });

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.equal(error.message, "Failed to read VCS project config at " + configPath + ".");
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
        assert.deepInclude(error, {
          operation: "read",
          cwd: root,
          configPath,
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  it.layer(TestLayer)("falls back to auto when config kind is invalid", (it) => {
    it.effect("returns auto", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-config-test-",
        });
        const configDir = path.join(root, ".t3code");
        yield* fileSystem.makeDirectory(configDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(configDir, "vcs.json"),
          `{"vcs":{"kind":"svn"}}`,
        );

        const config = yield* VcsProjectConfig.VcsProjectConfig;
        const kind = yield* config.resolveKind({ cwd: root });

        assert.equal(kind, "auto");
      }),
    );
  });
});
