import { KeybindingCommand } from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";

import {
  readKeybindingsConfig,
  makeKeybindingsLayer,
  writeKeybindingsConfig,
  toDetailResult,
} from "./keybindingsTestSupport.ts";

it.layer(NodeServices.layer)("keybindings", (it) => {
  it.effect("bootstraps default keybindings when config file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      assert.isFalse(yield* fs.exists(keybindingsConfigPath));

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, Keybindings.DEFAULT_KEYBINDINGS);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("replaces former terminal-conditioned defaults on startup", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
        { key: "mod+s", command: "composer.stash", when: "!terminalFocus" },
        { key: "mod+shift+j", command: "preview.toggle" },
        { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter(
          (binding) =>
            binding.command === "commandPalette.toggle" || binding.command === "composer.stash",
        ),
        [
          { key: "mod+k", command: "commandPalette.toggle" },
          { key: "mod+s", command: "composer.stash" },
        ],
      );
      assert.isFalse(persisted.some((binding) => binding.command.startsWith("preview.")));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("removes retired defaults on startup without removing user shortcuts", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" },
        { key: "mod+alt+n", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+shift+j", command: "terminal.toggle" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);

      const retiredStillPresent = persisted.filter(
        (binding) =>
          (binding.command === "chat.new" && binding.key !== "mod+alt+n") ||
          (binding.command === "terminal.toggle" && binding.key === "mod+j") ||
          binding.command === "filePicker.toggle",
      );

      assert.deepEqual(retiredStillPresent, []);
      assert.isTrue(
        persisted.some((binding) => binding.key === "mod+alt+n" && binding.command === "chat.new"),
      );
      assert.isTrue(
        persisted.some(
          (binding) => binding.key === "mod+shift+j" && binding.command === "terminal.toggle",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("uses defaults in runtime when config is malformed without overriding file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;

        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(
        configState.keybindings,
        Keybindings.compileResolvedKeybindingsConfig(Keybindings.DEFAULT_KEYBINDINGS),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.malformed-config",
          message: configState.issues[0]?.message ?? "",
        },
      ]);
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), "{ not-json");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("ignores invalid entries in runtime and reports them as issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify([
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+shift+d+o", command: "terminal.new" },
          { key: "mod+x", command: "invalid.command" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;

        return yield* keybindings.loadConfigState;
      });

      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
      assert.isFalse(
        configState.keybindings.some((entry) => String(entry.command) === "invalid.command"),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: configState.issues[0]?.message ?? "",
        },
        {
          kind: "keybindings.invalid-entry",
          index: 2,
          message: configState.issues[1]?.message ?? "",
        },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect(
    "upserts missing default keybindings on startup without overriding existing command rules",
    () =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          { key: "mod+shift+b", command: "sidebar.toggle" },
          { key: "mod+shift+r", command: "script.run-tests.run" },
        ]);

        yield* Effect.gen(function* () {
          const keybindings = yield* Keybindings.Keybindings;
          yield* keybindings.syncDefaultKeybindingsOnStartup;
        });

        const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
        const byCommand = new Map(persisted.map((entry) => [entry.command, entry]));

        const persistedToggle = byCommand.get("sidebar.toggle");
        assert.isNotNull(persistedToggle);
        assert.equal(persistedToggle?.key, "mod+shift+b");
        assert.isFalse(
          persisted.some((entry) => entry.command === "sidebar.toggle" && entry.key === "mod+b"),
        );

        for (const defaultRule of Keybindings.DEFAULT_KEYBINDINGS) {
          assert.isTrue(byCommand.has(defaultRule.command), `expected ${defaultRule.command}`);
        }

        assert.isTrue(byCommand.has("script.run-tests.run"));
      }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("skips conflicting default keybindings on startup and logs a detailed warning", () => {
    const messages: string[] = [];

    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });

    return Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+b", command: "script.custom-action.run" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.command === "sidebar.toggle"));
      assert.isTrue(persisted.some((entry) => entry.command === "script.custom-action.run"));

      assert.isTrue(
        messages.some((message) =>
          message.includes("skipping default keybinding due to shortcut conflict"),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeKeybindingsLayer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("upserts custom keybindings to configured path", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const resolved = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;

        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));

      assert.deepEqual(persistedView, [
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      assert.isTrue(resolved.some((entry) => entry.command === "script.run-tests.run"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("appends additional custom keybindings for the same command", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;

        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("replaces only the targeted custom keybinding", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;

        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "mod+r", command: "script.run-tests.run" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [
        { key: "mod+shift+r", command: "script.run-tests.run" },
        { key: "mod+alt+r", command: "script.run-tests.run" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("replacing with a rule that already exists elsewhere does not duplicate it", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+alt+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;

        return yield* keybindings.upsertKeybindingRule({
          key: "mod+alt+r",
          command: "script.run-tests.run",
          replace: { key: "mod+r", command: "script.run-tests.run" },
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+alt+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("removes only the targeted custom keybinding", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;

        return yield* keybindings.removeKeybindingRule({
          key: "mod+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+shift+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("refuses to overwrite malformed keybindings config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;

        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);

      assertFailure(result, "expected JSON array");

      const persistedRaw = yield* fs.readFileString(keybindingsConfigPath);
      assert.equal(persistedRaw, "{ not-json");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("reports non-array config parse errors without duplicate prefix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        '{"key":"mod+j","command":"terminal.toggle"}',
      );

      const firstResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;

        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);

      assertFailure(firstResult, "expected JSON array");

      const secondResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;

        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);

      assertFailure(secondResult, "expected JSON array");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("fails when config directory is not writable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      const { dirname } = yield* Path.Path;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);
      yield* fs.chmod(dirname(keybindingsConfigPath), 0o500);

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;

        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);

      assertFailure(result, "failed to write keybindings config");

      yield* fs.chmod(dirname(keybindingsConfigPath), 0o700);

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+j", command: "terminal.toggle" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("caches loaded resolved config across repeated reads", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const [first, second] = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        const firstLoad = (yield* keybindings.loadConfigState).keybindings;
        const secondLoad = (yield* keybindings.loadConfigState).keybindings;

        return [firstLoad, secondLoad] as const;
      });

      assert.deepEqual(first, second);
      assert.isTrue(second.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("updates cached resolved config after upsert", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const loadedAfterUpsert = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* keybindings.loadConfigState;
        yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });

        return (yield* keybindings.loadConfigState).keybindings;
      });

      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "script.run-tests.run"));
      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("serializes concurrent upserts to avoid lost updates", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);

      const commands = Array.from(
        { length: 20 },
        (_, index): KeybindingCommand => `script.concurrent-${index}.run`,
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings.Keybindings;
        yield* Effect.all(
          commands.map((command, index) =>
            keybindings.upsertKeybindingRule({
              key: `mod+${String.fromCharCode(97 + index)}`,
              command,
            }),
          ),
          { concurrency: "unbounded", discard: true },
        );
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedCommands = new Set(persisted.map((entry) => entry.command));

      for (const command of commands) {
        assert.isTrue(persistedCommands.has(command), `expected persisted command ${command}`);
      }
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );
});
