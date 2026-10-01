import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import {
  NodeFS,
  LOCK_STALE_AFTER_MS,
  LOCK_WAIT_LIMIT_MS,
  BotMemoryError,
  toBotMemoryError,
} from "./BotMemoryTypes.ts";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await NodeFS.access(filePath);

    return true;
  } catch (cause) {
    if ((Predicate.hasProperty(cause, "code") ? cause.code : undefined) === "ENOENT") return false;
    throw cause;
  }
}

export async function ensurePrivateDirectory(memoryRoot: string, directory: string): Promise<void> {
  const relative = NodePath.relative(memoryRoot, directory);

  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw BotMemoryError.fromCode("io-error", "Memory storage escaped its configured root.");
  }

  // A new profile may not have its state directory yet. That configured
  // directory is the trust boundary; every memory-owned segment below it is
  // still checked with lstat before it is used.
  await NodeFS.mkdir(NodePath.dirname(memoryRoot), { recursive: true, mode: 0o700 });
  const directories = [memoryRoot];

  if (relative) {
    let current = memoryRoot;

    for (const segment of relative.split(NodePath.sep)) {
      current = NodePath.join(current, segment);
      directories.push(current);
    }
  }

  for (const current of directories) {
    try {
      await NodeFS.mkdir(current, { mode: 0o700 });
    } catch (cause) {
      if ((Predicate.hasProperty(cause, "code") ? cause.code : undefined) !== "EEXIST") throw cause;
    }

    const stat = await NodeFS.lstat(current);

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw BotMemoryError.fromCode("io-error", "Memory directories may not be symbolic links.");
    }

    await NodeFS.chmod(current, 0o700);
  }
}

export async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    const stat = await NodeFS.lstat(filePath);

    if (stat.isSymbolicLink()) {
      throw BotMemoryError.fromCode("io-error", "Memory paths may not be symbolic links.");
    }
  } catch (cause) {
    if ((Predicate.hasProperty(cause, "code") ? cause.code : undefined) !== "ENOENT") throw cause;
  }
}

export async function assertMemoryPath(memoryRoot: string, filePath: string): Promise<void> {
  const relative = NodePath.relative(memoryRoot, filePath);

  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw BotMemoryError.fromCode("io-error", "Memory storage escaped its configured root.");
  }

  let current = memoryRoot;

  for (const segment of ["", ...relative.split(NodePath.sep)]) {
    if (segment) current = NodePath.join(current, segment);

    try {
      const stat = await NodeFS.lstat(current);

      if (stat.isSymbolicLink()) {
        throw BotMemoryError.fromCode("io-error", "Memory paths may not be symbolic links.");
      }
    } catch (cause) {
      if ((Predicate.hasProperty(cause, "code") ? cause.code : undefined) === "ENOENT") return;
      throw cause;
    }
  }
}

export interface BotMemoryFileLock {
  readonly verifyOwnership: () => Promise<void>;
}

export interface BotMemoryLockRecord {
  readonly pid: number;
  readonly token: string;
  readonly heartbeatAtMs: number;
}

export const readLockRecord = async (lockPath: string): Promise<BotMemoryLockRecord | null> => {
  const raw = await NodeFS.readFile(lockPath, "utf8").catch(() => null);

  if (raw === null) return null;

  try {
    return decodeLockRecord(raw);
  } catch {
    return null;
  }
};

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (cause) {
    if ((Predicate.hasProperty(cause, "code") ? cause.code : undefined) === "EPERM") return true;

    if ((Predicate.hasProperty(cause, "code") ? cause.code : undefined) === "ESRCH") return false;
    throw cause;
  }
};

export const acquireBotMemoryFileLock = Effect.fn("acquireBotMemoryFileLock")(function* (
  memoryRoot: string,
  filePath: string,
) {
  const lockPath = `${filePath}.lock`;
  const token = NodeCrypto.randomUUID();
  const pid = process.pid;
  yield* Effect.tryPromise({
    try: async () => {
      await ensurePrivateDirectory(memoryRoot, NodePath.dirname(filePath));
      await assertNotSymlink(lockPath);
    },
    catch: toBotMemoryError,
  });
  const record = (heartbeatAtMs: number): BotMemoryLockRecord => ({ pid, token, heartbeatAtMs });

  const readOwnRecord = async (): Promise<BotMemoryLockRecord | null> => {
    const current = await readLockRecord(lockPath);

    return current?.token === token && current.pid === pid ? current : null;
  };

  const verifyOwnership = async (): Promise<void> => {
    if (!(await readOwnRecord())) {
      throw BotMemoryError.fromCode(
        "lock-lost",
        "The memory file lock was taken by another owner.",
      );
    }
  };

  const release = (handle: NodeFSP.FileHandle) =>
    Effect.promise(async () => {
      const owned = await handle.stat().catch(() => null);
      await handle.close().catch(() => undefined);

      if (!owned) return;
      const current = await NodeFS.lstat(lockPath).catch(() => null);

      if (current && current.ino === owned.ino && current.dev === owned.dev) {
        await NodeFS.unlink(lockPath).catch(() => undefined);
      }
    });

  const open = Effect.tryPromise({
    try: async () => {
      const handle = await NodeFS.open(lockPath, "wx", 0o600);

      try {
        await handle.writeFile(
          JSON.stringify(record(DateTime.toEpochMillis(DateTime.nowUnsafe()))),
          "utf8",
        );
        await handle.sync();

        return handle;
      } catch (cause) {
        // Another writer may have reclaimed the lock path meanwhile; only remove our own inode.
        const owned = await handle.stat().catch(() => null);
        await handle.close().catch(() => undefined);
        const current = await NodeFS.lstat(lockPath).catch(() => null);

        if (owned && current && current.ino === owned.ino && current.dev === owned.dev) {
          await NodeFS.unlink(lockPath).catch(() => undefined);
        }

        throw cause;
      }
    },
    catch: (cause) =>
      (Predicate.hasProperty(cause, "code") ? cause.code : undefined) === "EEXIST"
        ? BotMemoryError.fromCode("lock-timeout", "Timed out waiting for the memory file lock.")
        : BotMemoryError.fromCode("io-error", "Could not acquire the memory file lock.", { cause }),
  });

  const acquire = open.pipe(
    Effect.catchReason("BotMemoryError", "lock-timeout", () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.tryPromise({
          try: async () => {
            await assertNotSymlink(lockPath);
            const existing = await readLockRecord(lockPath);
            let abandoned: boolean;

            if (existing) {
              abandoned =
                now - existing.heartbeatAtMs > LOCK_STALE_AFTER_MS && !isProcessAlive(existing.pid);
            } else {
              // A writer that crashed between creating the lock and syncing its record
              // leaves an empty or partial file. Live owners rewrite it every heartbeat,
              // so an unreadable record older than the stale threshold has no owner.
              const stat = await NodeFS.lstat(lockPath).catch(() => null);
              abandoned = stat !== null && now - stat.mtimeMs > LOCK_STALE_AFTER_MS;
            }

            if (abandoned) {
              const stalePath = `${lockPath}.stale-${NodeCrypto.randomUUID()}`;
              await NodeFS.rename(lockPath, stalePath).then(
                () => NodeFS.unlink(stalePath),
                (cause: NodeJS.ErrnoException) => {
                  if (cause.code !== "ENOENT") throw cause;
                },
              );
            }
          },
          catch: toBotMemoryError,
        });

        return yield* BotMemoryError.fromCode(
          "lock-timeout",
          "Timed out waiting for the memory file lock.",
        );
      }),
    ),
    Effect.retry({
      schedule: Schedule.spaced("15 millis").pipe(Schedule.upTo({ duration: LOCK_WAIT_LIMIT_MS })),
      while: (error) => Predicate.isTagged(error.reason, "lock-timeout"),
    }),
  );

  const handle = yield* Effect.acquireRelease(acquire, release);
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // Overwrite in place, then trim: truncating first would briefly expose an empty
      // record that makes verifyOwnership report a lost lock. Records never shrink.
      yield* Effect.promise(() =>
        handle
          .write(JSON.stringify(record(now)), 0, "utf8")
          .then(({ bytesWritten }) => handle.truncate(bytesWritten))
          .then(() => handle.sync())
          .catch(() => undefined),
      );
    }).pipe(Effect.repeat(Schedule.fixed("10 seconds"))),
  );

  return { verifyOwnership } satisfies BotMemoryFileLock;
});

export async function withFileLock<A>(
  memoryRoot: string,
  filePath: string,
  use: (lock: BotMemoryFileLock) => Promise<A>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lock = yield* acquireBotMemoryFileLock(memoryRoot, filePath);

        return yield* Effect.promise(() => use(lock));
      }),
    ),
  );
}

export async function writeMemoryFile(
  memoryRoot: string,
  filePath: string,
  contents: string,
  verifyOwnership?: () => Promise<void>,
): Promise<void> {
  await ensurePrivateDirectory(memoryRoot, NodePath.dirname(filePath));
  await assertNotSymlink(filePath);
  await verifyOwnership?.();
  // Check again after the slow staging and sync, so a writer that lost the lock
  // meanwhile never replaces the newer owner's file.
  let lostLock: BotMemoryError | undefined;
  await Effect.runPromise(
    writeFileStringAtomically({
      filePath,
      contents,
      mode: 0o600,
      durable: true,
      ...(verifyOwnership
        ? {
            beforeReplace: Effect.tryPromise({
              try: verifyOwnership,
              catch: (cause) => (lostLock = toBotMemoryError(cause)),
            }),
          }
        : {}),
    }).pipe(Effect.provide(NodeServices.layer)),
  ).catch((cause: unknown) => {
    throw lostLock ?? cause;
  });
}

const decodeLockRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      pid: Schema.Number.check(Schema.makeFilter(Number.isInteger)),
      token: Schema.String,
      heartbeatAtMs: Schema.Number,
    }),
  ),
);
