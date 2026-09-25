// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { subscriptionCredentialStore } from "./credentialStore.ts";

const decodeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** A credential file as Akeru and Mastra's AuthStorage write it today. */
const currentFormat = {
  anthropic: {
    type: "oauth",
    access: "anthropic-access",
    refresh: "anthropic-refresh",
    expires: 1_900_000_000_000,
  },
  "openai-codex": {
    type: "oauth",
    access: "codex-access",
    refresh: "codex-refresh",
    expires: 1_900_000_000_000,
    accountId: "account-1",
  },
  cursor: { type: "oauth", access: "cursor-access", refresh: "cursor-refresh", expires: 0 },
  xai: { type: "api-key", access: "xai-key" },
  "opencode-go": { type: "api-key", access: "go-key", baseUrl: "https://proxy.example/v1" },
  "apikey:openai": { type: "api_key", key: "mastra-openai-key" },
} as const;

const authFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-credential-store-" });
  return { directory, authPath: path.join(directory, "subscription-auth.json") };
});

const readJson = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return decodeJson(yield* fs.readFileString(filePath));
  });

it.layer(NodeServices.layer)("subscription credential store", (it) => {
  it.effect("starts empty when no file exists", () =>
    Effect.gen(function* () {
      const { authPath } = yield* authFile;
      const store = yield* subscriptionCredentialStore(authPath);
      assert.deepStrictEqual(store.current(), { data: {} });
    }),
  );

  it.effect("loads the current on-disk format unchanged and keeps it through a rewrite", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { authPath } = yield* authFile;
      yield* fs.writeFileString(authPath, encodeJson(currentFormat));

      const store = yield* subscriptionCredentialStore(authPath);
      assert.deepStrictEqual(store.current(), { data: currentFormat });

      yield* store.update(({ xai: _removed, ...rest }) => rest);
      const { xai: _xai, ...expected } = currentFormat;
      assert.deepStrictEqual(yield* readJson(authPath), expected);
      assert.deepStrictEqual(store.current(), { data: expected });
    }),
  );

  it.effect("reports a damaged file as a typed error instead of an empty login", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { authPath } = yield* authFile;
      for (const [index, text] of [
        "{not json",
        encodeJson({ anthropic: { type: "oauth", access: "missing refresh and expiry" } }),
        `["not", "an", "object"]`,
      ].entries()) {
        const filePath = `${authPath}.${index}`;
        yield* fs.writeFileString(filePath, text);
        const state = (yield* subscriptionCredentialStore(filePath)).current();
        assert.deepStrictEqual(state.data, {});
        assert.strictEqual(state.loadError?._tag, "SubscriptionCredentialStoreError");
        assert.strictEqual(state.loadError?.reason, "corrupt");
        assert.match(state.loadError?.message ?? "", /damaged/);
        assert.isString(state.loadErrorAt);
        // Reading never rewrites or deletes the damaged file.
        assert.strictEqual(yield* fs.readFileString(filePath), text);
      }
    }),
  );

  it.effect("clears a load error when the file is repaired and reloaded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { authPath } = yield* authFile;
      yield* fs.writeFileString(authPath, "{not json");
      const store = yield* subscriptionCredentialStore(authPath);
      assert.strictEqual(store.current().loadError?.reason, "corrupt");

      yield* fs.writeFileString(authPath, encodeJson({ xai: currentFormat.xai }));
      assert.deepStrictEqual(yield* store.reload, { data: { xai: currentFormat.xai } });
    }),
  );

  it.effect("keeps a damaged file beside the new one when a write replaces it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { authPath } = yield* authFile;
      yield* fs.writeFileString(authPath, "{not json");
      const store = yield* subscriptionCredentialStore(authPath);

      yield* store.update((data) => ({ ...data, xai: currentFormat.xai }));
      assert.deepStrictEqual(yield* readJson(authPath), { xai: currentFormat.xai });
      assert.strictEqual(yield* fs.readFileString(`${authPath}.corrupt`), "{not json");
      assert.deepStrictEqual(store.current(), { data: { xai: currentFormat.xai } });
    }),
  );

  it.effect("writes atomically with owner-only permissions and no temp files left", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { directory, authPath } = yield* authFile;
      yield* fs.writeFileString(authPath, encodeJson({}), { mode: 0o644 });
      const store = yield* subscriptionCredentialStore(authPath);

      yield* store.update((data) => ({ ...data, xai: currentFormat.xai }));
      assert.strictEqual((yield* fs.stat(authPath)).mode & 0o777, 0o600);
      assert.deepStrictEqual(yield* fs.readDirectory(directory), ["subscription-auth.json"]);
    }),
  );

  it.effect("fails a write with a typed error and keeps the last good state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { directory, authPath } = yield* authFile;
      const store = yield* subscriptionCredentialStore(authPath);
      // A read-only directory lets the reread succeed but blocks the temp file.
      yield* fs.chmod(directory, 0o500);
      const error = yield* Effect.flip(
        store.update((data) => ({ ...data, xai: currentFormat.xai })),
      ).pipe(Effect.ensuring(fs.chmod(directory, 0o700).pipe(Effect.ignore)));
      assert.strictEqual(error.reason, "write");
      assert.deepStrictEqual(store.current(), { data: {} });
      assert.isFalse(yield* fs.exists(authPath));
    }),
  );

  it.effect("refuses to overwrite a file it cannot read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { authPath } = yield* authFile;
      // A directory at the credential path cannot be read as a file.
      yield* fs.makeDirectory(authPath);
      const store = yield* subscriptionCredentialStore(authPath);
      assert.strictEqual(store.current().loadError?.reason, "unreadable");

      const error = yield* Effect.flip(
        store.update((data) => ({ ...data, xai: currentFormat.xai })),
      );
      assert.strictEqual(error.reason, "unreadable");
      assert.isTrue((yield* fs.stat(authPath)).type === "Directory");
    }),
  );

  it.effect("serializes concurrent read-modify-write updates without losing any", () =>
    Effect.gen(function* () {
      const { authPath } = yield* authFile;
      const store = yield* subscriptionCredentialStore(authPath);
      const keys = Array.from({ length: 16 }, (_, index) => `apikey:provider-${index}`);

      yield* Effect.all(
        keys.map((key) => store.update((data) => ({ ...data, [key]: { type: "api_key", key } }))),
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(Object.keys(yield* readJson(authPath)).toSorted(), keys.toSorted());
    }),
  );

  it.effect("shares one store per file so every reader sees a write", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { directory, authPath } = yield* authFile;
      const first = yield* subscriptionCredentialStore(authPath);
      const second = yield* subscriptionCredentialStore(
        path.join(directory, ".", "subscription-auth.json"),
      );
      assert.strictEqual(first, second);

      yield* first.update((data) => ({ ...data, xai: currentFormat.xai }));
      assert.deepStrictEqual(second.current(), { data: { xai: currentFormat.xai } });
    }),
  );

  it.effect("rereads on current() when another writer changes the file", () =>
    Effect.gen(function* () {
      const { authPath } = yield* authFile;
      NodeFS.writeFileSync(authPath, encodeJson({ xai: currentFormat.xai }));
      const store = yield* subscriptionCredentialStore(authPath);
      assert.deepStrictEqual(store.current(), { data: { xai: currentFormat.xai } });

      // An in-place write, as Mastra's AuthStorage does it.
      NodeFS.writeFileSync(authPath, encodeJson(currentFormat));
      assert.deepStrictEqual(store.current(), { data: currentFormat });

      // A rename over the file, as another store instance or process does it.
      const replacement = { "opencode-go": currentFormat["opencode-go"] };
      NodeFS.writeFileSync(`${authPath}.next`, encodeJson(replacement));
      NodeFS.renameSync(`${authPath}.next`, authPath);
      assert.deepStrictEqual(store.current(), { data: replacement });

      NodeFS.rmSync(authPath);
      assert.deepStrictEqual(store.current(), { data: {} });
    }),
  );

  it.effect("does not reread an unchanged file", () =>
    Effect.gen(function* () {
      const { authPath } = yield* authFile;
      NodeFS.writeFileSync(authPath, encodeJson({ xai: currentFormat.xai }));
      const store = yield* subscriptionCredentialStore(authPath);
      const first = store.current();
      assert.strictEqual(store.current(), first);
      yield* store.update((data) => ({ ...data, "opencode-go": currentFormat["opencode-go"] }));
      const written = store.current();
      // The store's own write is already the current state.
      assert.strictEqual(store.current(), written);
    }),
  );

  it.effect("keeps serving the last good state when a reread finds the file damaged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { authPath } = yield* authFile;
      NodeFS.writeFileSync(authPath, encodeJson({ xai: currentFormat.xai }));
      const store = yield* subscriptionCredentialStore(authPath);

      NodeFS.writeFileSync(authPath, "{not json");
      const damaged = store.current();
      assert.deepStrictEqual(damaged.data, { xai: currentFormat.xai });
      assert.strictEqual(damaged.loadError?.reason, "corrupt");
      assert.strictEqual(damaged.servingLastGood, true);
      assert.isString(damaged.loadErrorAt);

      // A second damaged version keeps the same last good state and first-seen time.
      NodeFS.writeFileSync(authPath, "{still not json");
      const reloaded = yield* store.reload;
      assert.deepStrictEqual(reloaded.data, { xai: currentFormat.xai });
      assert.strictEqual(reloaded.servingLastGood, true);
      assert.strictEqual(reloaded.loadErrorAt, damaged.loadErrorAt);

      // The next write builds on the last good state and sets the damaged file aside.
      yield* store.update((data) => ({ ...data, "opencode-go": currentFormat["opencode-go"] }));
      const expected = { xai: currentFormat.xai, "opencode-go": currentFormat["opencode-go"] };
      assert.deepStrictEqual(yield* readJson(authPath), expected);
      assert.strictEqual(yield* fs.readFileString(`${authPath}.corrupt`), "{still not json");
      assert.deepStrictEqual(store.current(), { data: expected });
    }),
  );

  it.effect("stays empty when the file was damaged before any good read", () =>
    Effect.gen(function* () {
      const { authPath } = yield* authFile;
      NodeFS.writeFileSync(authPath, "{not json");
      const store = yield* subscriptionCredentialStore(authPath);
      NodeFS.writeFileSync(authPath, "{still not json");
      const state = store.current();
      assert.deepStrictEqual(state.data, {});
      assert.strictEqual(state.loadError?.reason, "corrupt");
      assert.isUndefined(state.servingLastGood);

      NodeFS.writeFileSync(authPath, encodeJson({ xai: currentFormat.xai }));
      assert.deepStrictEqual(store.current(), { data: { xai: currentFormat.xai } });
    }),
  );
});
