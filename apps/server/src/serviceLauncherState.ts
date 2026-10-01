// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ServiceState } from "./cloud/serviceProtocol.ts";
import { parseServiceState, SERVICE_STOP_MARKER_FILE } from "./cloud/serviceProtocol.ts";

import { syncDirectory } from "./serviceLauncherDatabase.ts";

export const runtimePaths = (baseDir: string, version: string) => {
  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
  return {
    versionDir,
    entryPath: NodePath.join(versionDir, "node_modules", "akeru-bot", "dist", "bin.mjs"),
    sentinelPath: NodePath.join(versionDir, ".install-complete"),
  };
};

/**
 * The Node binary that runs one runtime version. Windows archives bundle their own Node, so an
 * update runs on the Node it was built for; other installs keep the launcher's Node.
 */
export async function runtimeNodePath(versionDir: string): Promise<string> {
  const bundled = NodePath.join(versionDir, "node", "node.exe");
  const stat = await NodeFSP.stat(bundled).catch(() => undefined);
  return stat?.isFile() ? bundled : process.execPath;
}

export async function readServiceState(filePath: string): Promise<ServiceState> {
  const contents = await NodeFSP.readFile(filePath, "utf8");
  const state = parseServiceState(contents);
  if (state === undefined) throw new Error("Service state is invalid or unsupported.");
  return state;
}

/** Durable same-directory replacement used for every runtime state transition. */
export async function writeServiceState(filePath: string, state: ServiceState): Promise<void> {
  const directory = NodePath.dirname(filePath);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await NodeFSP.rename(tempPath, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function runtimeExists(baseDir: string, version: string): Promise<boolean> {
  const paths = runtimePaths(baseDir, version);
  try {
    const [entry, sentinel] = await Promise.all([
      NodeFSP.stat(paths.entryPath),
      NodeFSP.readFile(paths.sentinelPath, "utf8"),
    ]);
    return entry.isFile() && sentinel.trim() === version;
  } catch {
    return false;
  }
}

export const stopMarkerPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_STOP_MARKER_FILE);
