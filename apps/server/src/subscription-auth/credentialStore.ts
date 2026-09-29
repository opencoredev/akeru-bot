// @effect-diagnostics nodeBuiltinImport:off
/**
 * The subscription credential file: `<secretsDir>/subscription-auth.json`.
 *
 * Every `SubscriptionAuthService` in the process shares one store per file, so
 * a login in one service is visible to synchronous readers in another without
 * rereading the disk. Other writers (Mastra's `AuthStorage`, another process)
 * are caught by a cheap stat: `current()` rereads when the file's device,
 * inode, size, or mtime changed since the store last read or wrote it.
 *
 * Reads decode with Schema. A file that cannot be decoded becomes a typed
 * `SubscriptionCredentialStoreError` on the store state. If the store already
 * holds a good state from this process it keeps serving it and marks the state
 * `servingLastGood`; otherwise the state is empty, as if logged out. Writes
 * serialize through a semaphore, reread the file first, and replace it
 * atomically.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const OAuthCredentialSchema = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literal("oauth"),
    refresh: Schema.String,
    access: Schema.String,
    expires: Schema.Number,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const ApiKeyCredentialSchema = Schema.Struct({
  type: Schema.Literal("api-key"),
  access: Schema.String,
  baseUrl: Schema.optionalKey(Schema.String),
  connectionId: Schema.optionalKey(Schema.String),
});

const SubscriptionCredentialSchema = Schema.Union([OAuthCredentialSchema, ApiKeyCredentialSchema]);

/**
 * Known provider entries are validated. Other keys, such as Mastra's
 * `apikey:<provider>` records, pass through untouched and survive rewrites.
 */
export const SubscriptionAuthDataSchema = Schema.StructWithRest(
  Schema.Struct({
    anthropic: Schema.optionalKey(SubscriptionCredentialSchema),
    "openai-codex": Schema.optionalKey(SubscriptionCredentialSchema),
    cursor: Schema.optionalKey(SubscriptionCredentialSchema),
    xai: Schema.optionalKey(SubscriptionCredentialSchema),
    "kimi-for-coding": Schema.optionalKey(SubscriptionCredentialSchema),
    "opencode-go": Schema.optionalKey(SubscriptionCredentialSchema),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export type SubscriptionAuthData = typeof SubscriptionAuthDataSchema.Type;

const decodeAuthData = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SubscriptionAuthDataSchema),
);
const decodeAuthDataResult = Schema.decodeUnknownResult(
  Schema.fromJsonString(SubscriptionAuthDataSchema),
);
const encodeAuthData = Schema.encodeEffect(Schema.fromJsonString(SubscriptionAuthDataSchema));

/** The credential file could not be read, decoded, or written. */
export class SubscriptionCredentialStoreError extends Schema.TaggedErrorClass<SubscriptionCredentialStoreError>()(
  "SubscriptionCredentialStoreError",
  {
    reason: Schema.Literals(["corrupt", "unreadable", "write"]),
    path: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "corrupt":
        return "Saved subscription credentials are damaged and could not be loaded. Reconnect to replace them.";
      case "unreadable":
        return "Saved subscription credentials could not be read. Check the secrets directory permissions.";
      case "write":
        return "Subscription credentials could not be saved.";
    }
  }
}

export interface CredentialStoreState {
  readonly data: SubscriptionAuthData;
  /** Set when the last read failed. `data` is then the last good state or empty. */
  readonly loadError?: SubscriptionCredentialStoreError;
  /** ISO time the file was first seen damaged. */
  readonly loadErrorAt?: string;
  /** With `loadError`: `data` is the last state this process read or wrote successfully. */
  readonly servingLastGood?: true;
}

export interface SubscriptionCredentialStore {
  readonly path: string;
  /**
   * The current state for synchronous readers. Rereads first when the file
   * changed on disk since the store last read or wrote it.
   */
  readonly current: () => CredentialStoreState;
  /** Reread the file. A failed read is recorded on the state, not raised. */
  readonly reload: Effect.Effect<CredentialStoreState>;
  /**
   * Reread, apply `f`, and write atomically. A damaged file is kept beside the
   * original as `<file>.corrupt` before it is replaced.
   */
  readonly update: (
    f: (data: SubscriptionAuthData) => SubscriptionAuthData,
  ) => Effect.Effect<SubscriptionAuthData, SubscriptionCredentialStoreError>;
}

const stores = new Map<string, SubscriptionCredentialStore>();
const initializing = new Map<string, Deferred.Deferred<SubscriptionCredentialStore>>();

/** The process-wide store for `filePath`, created on first use and loaded from disk. */
export const subscriptionCredentialStore = Effect.fn("subscriptionCredentialStore")(function* (
  filePath: string,
) {
  const path = yield* Path.Path;
  const resolved = path.resolve(filePath);
  const lookup = yield* Effect.sync(() => {
    const existing = stores.get(resolved);
    if (existing) return { type: "ready" as const, store: existing };
    const pending = initializing.get(resolved);
    if (pending) return { type: "pending" as const, pending };
    const started = Deferred.makeUnsafe<SubscriptionCredentialStore>();
    initializing.set(resolved, started);
    return { type: "create" as const, pending: started };
  });
  if (lookup.type === "ready") return lookup.store;
  if (lookup.type === "pending") return yield* Deferred.await(lookup.pending);
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const result = yield* Effect.exit(makeSubscriptionCredentialStore(resolved));
      if (Exit.isSuccess(result)) stores.set(resolved, result.value);
      initializing.delete(resolved);
      yield* Deferred.done(lookup.pending, result);
      return yield* result;
    }),
  );
});

const makeSubscriptionCredentialStore = Effect.fn("makeSubscriptionCredentialStore")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storeError = (
    reason: "corrupt" | "unreadable" | "write",
    cause: { readonly message: string },
  ) => new SubscriptionCredentialStoreError({ reason, path: filePath, detail: cause.message });

  const read: Effect.Effect<SubscriptionAuthData, SubscriptionCredentialStoreError> = Effect.gen(
    function* () {
      if (!(yield* fs.exists(filePath))) return {};
      const text = yield* fs.readFileString(filePath);
      return yield* decodeAuthData(text).pipe(
        Effect.mapError((cause) => storeError("corrupt", cause)),
      );
    },
  ).pipe(Effect.catchTag("PlatformError", (cause) => Effect.fail(storeError("unreadable", cause))));

  // The same read for `current()`, which cannot wait on the Effect file system.
  const readSync = (): Result.Result<SubscriptionAuthData, SubscriptionCredentialStoreError> => {
    let text: string;
    try {
      if (!NodeFS.existsSync(filePath)) return Result.succeed({});
      text = NodeFS.readFileSync(filePath, "utf-8");
    } catch (cause) {
      return Result.fail(storeError("unreadable", { message: String(cause) }));
    }
    return Result.mapError(decodeAuthDataResult(text), (cause) => storeError("corrupt", cause));
  };

  /** A failed read keeps the last good state, if this process has one. */
  const settle = (
    previous: CredentialStoreState | undefined,
    result: Result.Result<SubscriptionAuthData, SubscriptionCredentialStoreError>,
    at: string,
  ): CredentialStoreState => {
    if (Result.isSuccess(result)) return { data: result.success };
    const loadErrorAt = previous?.loadError ? (previous.loadErrorAt ?? at) : at;
    const hasLastGood =
      previous !== undefined && (previous.loadError === undefined || previous.servingLastGood);
    return hasLastGood
      ? { data: previous.data, loadError: result.failure, loadErrorAt, servingLastGood: true }
      : { data: {}, loadError: result.failure, loadErrorAt };
  };

  const logDamage = (previous: CredentialStoreState | undefined, next: CredentialStoreState) =>
    next.loadError && !previous?.loadError
      ? Effect.logWarning("Subscription credential file could not be loaded", {
          path: filePath,
          reason: next.loadError.reason,
          detail: next.loadError.detail,
          servingLastGood: next.servingLastGood === true,
        })
      : Effect.void;

  // Temp file in the target directory, restricted before it becomes visible under the real name.
  // Returns the fingerprint of the written file; rename keeps its inode and mtime.
  const writeAtomically = (data: SubscriptionAuthData) =>
    Effect.gen(function* () {
      const directory = path.dirname(filePath);
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const tempPath = path.join(
        directory,
        `${path.basename(filePath)}.${NodeCrypto.randomUUID()}.tmp`,
      );
      const text = yield* encodeAuthData(data);
      return yield* Effect.gen(function* () {
        yield* fs.writeFileString(tempPath, text, { mode: 0o600 });
        yield* fs.chmod(tempPath, 0o600);
        const written = fileFingerprint(tempPath);
        yield* fs.rename(tempPath, filePath);
        return written;
      }).pipe(Effect.onError(() => fs.remove(tempPath, { force: true }).pipe(Effect.ignore)));
    }).pipe(Effect.mapError((cause) => storeError("write", cause)));

  const lock = yield* Semaphore.make(1);
  // True while `reload` or `update` owns the file, so `current()` does not
  // reread a half-finished replacement.
  let busy = false;
  const exclusive = <A, E>(effect: Effect.Effect<A, E>) =>
    lock.withPermit(
      Effect.suspend(() => {
        busy = true;
        return effect;
      }).pipe(Effect.ensuring(Effect.sync(() => (busy = false)))),
    );

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // Clock and logger of the creator, for the synchronous reread in `current()`.
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());

  let fingerprint = fileFingerprint(filePath);
  let state = settle(undefined, yield* Effect.result(read), yield* now);
  yield* logDamage(undefined, state);

  const reload = exclusive(
    Effect.gen(function* () {
      const seen = fileFingerprint(filePath);
      const next = settle(state, yield* Effect.result(read), yield* now);
      yield* logDamage(state, next);
      fingerprint = seen;
      state = next;
      return next;
    }),
  );

  return {
    path: filePath,
    current: () => {
      if (busy) return state;
      const seen = fileFingerprint(filePath);
      if (seen === fingerprint) return state;
      const previous = state;
      const next = settle(previous, readSync(), runSync(now));
      runSync(logDamage(previous, next));
      fingerprint = seen;
      state = next;
      return state;
    },
    reload,
    update: (f) =>
      exclusive(
        Effect.gen(function* () {
          const loaded = settle(state, yield* Effect.result(read), yield* now);
          if (loaded.loadError?.reason === "unreadable") return yield* loaded.loadError;
          if (loaded.loadError?.reason === "corrupt") {
            yield* fs
              .rename(filePath, `${filePath}.corrupt`)
              .pipe(Effect.mapError((cause) => storeError("write", cause)));
          }
          const next = f(loaded.data);
          fingerprint = yield* writeAtomically(next);
          state = { data: next };
          return next;
        }),
      ),
  } satisfies SubscriptionCredentialStore;
});

/**
 * Identifies one version of a file without reading it. Stat failures other than
 * a missing file collapse to one value, so an unreadable path is not reread on
 * every `current()`.
 */
function fileFingerprint(filePath: string): string {
  try {
    const stat = NodeFS.statSync(filePath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable";
  }
}
