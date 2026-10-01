import * as Predicate from "effect/Predicate";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { PendingServiceUpdate } from "./cloud/serviceProtocol.ts";

/** SQLite persists across the main file plus its WAL and shared-memory sidecars. */
export const DB_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;

export const RESTORE_MARKER = ".restore-pending";

export const databaseBackupDir = (baseDir: string, updateId: string) =>
  NodePath.join(baseDir, "runtime", "db-backup", updateId);

export const databaseBackupFile = (backupDir: string, suffix: (typeof DB_FILE_SUFFIXES)[number]) =>
  NodePath.join(backupDir, suffix === "" ? "database" : `database${suffix}`);

export async function pathExists(target: string): Promise<boolean> {
  try {
    await NodeFSP.access(target);

    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

export async function syncFile(filePath: string): Promise<void> {
  const handle = await NodeFSP.open(filePath, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]);

/**
 * Flushes a directory entry where the platform allows it. Windows cannot sync a directory.
 * `open` is replaceable so tests can simulate filesystems that reject a directory sync.
 */
export async function syncDirectory(
  directory: string,
  open: (
    path: string,
    flags: string,
  ) => Promise<Pick<NodeFSP.FileHandle, "sync" | "close">> = NodeFSP.open,
): Promise<void> {
  try {
    const handle = await open(directory, "r");

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;

    if (Predicate.isString(code) && UNSUPPORTED_DIRECTORY_SYNC.has(code)) return;
    throw error;
  }
}

/**
 * Snapshots the database once per update before the first trial. A completed
 * backup is never overwritten because a restarted launcher may be looking at
 * database writes from an earlier attempt by the same trial.
 */
export async function backupDatabaseOnce(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);

  if (await pathExists(backupDir)) return;

  const stagingDir = `${backupDir}.staging`;
  await NodeFSP.rm(stagingDir, { recursive: true, force: true });
  await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });

  try {
    for (const suffix of DB_FILE_SUFFIXES) {
      const source = `${pending.dbPath}${suffix}`;

      if (suffix !== "" && !(await pathExists(source))) continue;
      const destination = databaseBackupFile(stagingDir, suffix);
      await NodeFSP.copyFile(source, destination);
      await syncFile(destination);
    }

    await NodeFSP.rename(stagingDir, backupDir);
    await syncDirectory(NodePath.dirname(backupDir));
  } catch (cause) {
    await NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

export const restoreMarkerPath = (baseDir: string, updateId: string) =>
  NodePath.join(databaseBackupDir(baseDir, updateId), RESTORE_MARKER);

export const databaseRestorePending = (baseDir: string, pending: PendingServiceUpdate) =>
  pathExists(restoreMarkerPath(baseDir, pending.id));

/** Mark rollback before changing live files so launcher recovery cannot boot a partial restore. */
export async function markDatabaseRestorePending(backupDir: string): Promise<void> {
  const markerPath = NodePath.join(backupDir, RESTORE_MARKER);

  if (!(await pathExists(markerPath))) {
    const handle = await NodeFSP.open(markerPath, "wx", 0o600);

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    await syncDirectory(backupDir);
  }
}

/** Restore is retryable after any process crash while the backup directory remains. */
export async function restoreDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);

  if (!(await pathExists(backupDir))) return;

  await markDatabaseRestorePending(backupDir);

  for (const suffix of DB_FILE_SUFFIXES) {
    const target = `${pending.dbPath}${suffix}`;
    const source = databaseBackupFile(backupDir, suffix);

    if (await pathExists(source)) {
      await NodeFSP.copyFile(source, target);
      await syncFile(target);
    } else {
      await NodeFSP.rm(target, { force: true });
    }
  }

  await syncDirectory(NodePath.dirname(pending.dbPath));
}

export async function discardDatabaseBackup(baseDir: string, updateId: string): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, updateId);

  if (!(await pathExists(backupDir))) return;
  await NodeFSP.rm(backupDir, { recursive: true, force: true });
  await syncDirectory(NodePath.dirname(backupDir));
}
