#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - Release packaging runs before an Effect runtime exists.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Akeru Remote release assets. The installers in scripts/install-remote.sh and
// scripts/install-remote.ps1 download exactly these names; keep the three in sync.
export const REMOTE_TARGETS = [
  { platform: "linux", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "win32", arch: "x64" },
] as const;

export type RemoteTarget = (typeof REMOTE_TARGETS)[number];

export const REMOTE_MANIFEST = "AKERU-REMOTE-MANIFEST.txt";
export const REMOTE_MANIFEST_SIGNATURE = "AKERU-REMOTE-MANIFEST.sig";
export const REMOTE_INSTALLERS = ["install-remote.sh", "install-remote.ps1"] as const;
// The Linux installer only fetches Tailscale packages the signed manifest authorizes.
export const TAILSCALE_VERSION = "1.88.4";
export const TAILSCALE_ARCHIVES = [`tailscale_${TAILSCALE_VERSION}_amd64.tgz`] as const;

const scriptsDirectory = import.meta.dirname;

export function remoteArchiveName(version: string, target: RemoteTarget): string {
  const extension = target.platform === "win32" ? "zip" : "tar.gz";
  return `Akeru-Remote-${version}-${target.platform}-${target.arch}.${extension}`;
}

export function expectedRemoteAssetNames(version: string): readonly string[] {
  return [
    ...REMOTE_TARGETS.map((target) => remoteArchiveName(version, target)),
    REMOTE_MANIFEST,
    REMOTE_MANIFEST_SIGNATURE,
    ...REMOTE_INSTALLERS,
  ];
}

export function remoteTargetFor(platform: string, arch: string): RemoteTarget {
  const target = REMOTE_TARGETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!target) throw new Error(`Akeru Remote is not published for ${platform} ${arch}.`);
  return target;
}

const UNIX_LAUNCHER = `#!/bin/sh
set -eu
self="$0"
while [ -L "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
root="$(CDPATH= cd -- "$(dirname "$self")" && pwd)"
# Akeru state lives in AKERU_HOME or ~/.akeru. The server reads T3CODE_HOME, so it is derived here
# and never inherited from an ambient T3 Code environment.
AKERU_HOME="\${AKERU_HOME:-$HOME/.akeru}"
T3CODE_HOME="$AKERU_HOME"
export AKERU_HOME T3CODE_HOME
if [ "$#" -gt 0 ] && [ "$1" = remote ]; then
  shift
  exec "$root/remote-admin" "$@"
fi
exec "$root/node/bin/node" "$root/node_modules/akeru-bot/dist/bin.mjs" "$@"
`;

const WINDOWS_LAUNCHER = [
  "@echo off",
  "setlocal",
  'if not defined AKERU_HOME set "AKERU_HOME=%USERPROFILE%\\.akeru"',
  'set "T3CODE_HOME=%AKERU_HOME%"',
  'if /I "%~1"=="remote" goto remote',
  '"%~dp0node\\node.exe" "%~dp0node_modules\\akeru-bot\\dist\\bin.mjs" %*',
  "exit /b %ERRORLEVEL%",
  ":remote",
  'set "AKERU_REMOTE_ARGS="',
  "shift",
  ":collect",
  'if "%~1"=="" goto run_remote',
  "set AKERU_REMOTE_ARGS=%AKERU_REMOTE_ARGS% %1",
  "shift",
  "goto collect",
  ":run_remote",
  '"%~dp0node\\node.exe" "%~dp0remote-admin.mjs" %AKERU_REMOTE_ARGS%',
  "exit /b %ERRORLEVEL%",
  "",
].join("\r\n");

const run = (command: string, args: readonly string[]) => {
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed.`);
};

/**
 * Assembles one Akeru Remote archive from a production runtime tree (the output of
 * `pnpm deploy --prod` for akeru-bot, with dist moved to node_modules/akeru-bot/dist) and the
 * Node binary that runs it. Unix archives hold one top-level directory the installer strips;
 * Windows archives hold `akeru\\`.
 */
export function packageRemoteArchive(input: {
  readonly runtimeDirectory: string;
  readonly outputDirectory: string;
  readonly version: string;
  readonly target: RemoteTarget;
  /** Must be built for `target`; the release runs this on the matching native runner. */
  readonly nodeBinary: string;
  readonly license: string;
}): string {
  const { target, version } = input;
  const windows = target.platform === "win32";
  const staging = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-remote-package-"));
  try {
    const rootName = windows
      ? "akeru"
      : `Akeru-Remote-${version}-${target.platform}-${target.arch}`;
    const root = NodePath.join(staging, rootName);
    NodeFS.cpSync(input.runtimeDirectory, root, { recursive: true, verbatimSymlinks: true });
    if (!NodeFS.existsSync(NodePath.join(root, "node_modules", "akeru-bot", "dist", "bin.mjs"))) {
      throw new Error("The runtime tree is missing node_modules/akeru-bot/dist/bin.mjs.");
    }
    const copy = (source: string, destination: string, mode = 0o644) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, destination)), { recursive: true });
      NodeFS.copyFileSync(source, NodePath.join(root, destination));
      NodeFS.chmodSync(NodePath.join(root, destination), mode);
    };
    NodeFS.writeFileSync(NodePath.join(root, "VERSION"), `${version}\n`);
    copy(input.license, "LICENSE");
    if (windows) {
      copy(input.nodeBinary, NodePath.join("node", "node.exe"), 0o755);
      NodeFS.writeFileSync(NodePath.join(root, "akeru.cmd"), WINDOWS_LAUNCHER);
      copy(NodePath.join(scriptsDirectory, "akeru-remote-admin.mjs"), "remote-admin.mjs");
      copy(
        NodePath.join(scriptsDirectory, "initialize-remote-identity.cjs"),
        "initialize-remote-identity.cjs",
      );
    } else {
      copy(input.nodeBinary, NodePath.join("node", "bin", "node"), 0o755);
      NodeFS.writeFileSync(NodePath.join(root, "akeru"), UNIX_LAUNCHER, { mode: 0o755 });
      copy(NodePath.join(scriptsDirectory, "akeru-remote-admin.sh"), "remote-admin", 0o755);
      copy(
        NodePath.join(scriptsDirectory, "initialize-remote-identity.sh"),
        "initialize-remote-identity.sh",
        0o755,
      );
      copy(NodePath.join(scriptsDirectory, "install-remote.sh"), "install-remote.sh", 0o755);
    }

    NodeFS.mkdirSync(input.outputDirectory, { recursive: true });
    const archive = NodePath.join(input.outputDirectory, remoteArchiveName(version, target));
    if (windows) {
      // Windows' bundled bsdtar writes zip archives that Expand-Archive reads.
      const tar = NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
      run(tar, ["-a", "-cf", archive, "-C", staging, rootName]);
    } else {
      run("tar", ["-czf", archive, "-C", staging, rootName]);
    }
    return archive;
  } finally {
    NodeFS.rmSync(staging, { recursive: true, force: true });
  }
}

const sha256 = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");

/**
 * Writes and signs the manifest the Unix installer verifies with the pinned Ed25519 key in
 * scripts/akeru-release-manifest.pub. `directory` must already hold every remote archive and the
 * two installers; `externalChecksums` maps pinned third-party packages to their SHA-256.
 */
export function writeRemoteManifest(input: {
  readonly directory: string;
  readonly version: string;
  readonly privateKeyPem: string;
  readonly externalChecksums: Readonly<Record<string, string>>;
  readonly publicKeyPem?: string;
}): string {
  const lines = [
    ...REMOTE_TARGETS.map((target) => remoteArchiveName(input.version, target)),
    ...REMOTE_INSTALLERS,
  ].map((name) => `${sha256(NodePath.join(input.directory, name))}  ${name}`);
  for (const name of TAILSCALE_ARCHIVES) {
    const checksum = input.externalChecksums[name];
    if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
      throw new Error(`A SHA-256 checksum is required for ${name}.`);
    }
    lines.push(`${checksum}  ${name}`);
  }
  const manifest = Buffer.from(`${lines.join("\n")}\n`);
  const signature = NodeCrypto.sign(null, manifest, input.privateKeyPem);
  const publicKey =
    input.publicKeyPem ??
    NodeFS.readFileSync(NodePath.join(scriptsDirectory, "akeru-release-manifest.pub"), "utf8");
  if (!NodeCrypto.verify(null, manifest, publicKey, signature)) {
    throw new Error("The manifest signing key does not match scripts/akeru-release-manifest.pub.");
  }
  NodeFS.writeFileSync(NodePath.join(input.directory, REMOTE_MANIFEST), manifest);
  NodeFS.writeFileSync(NodePath.join(input.directory, REMOTE_MANIFEST_SIGNATURE), signature);
  return manifest.toString("utf8");
}

async function fetchTailscaleChecksums(): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};
  for (const name of TAILSCALE_ARCHIVES) {
    const response = await fetch(`https://pkgs.tailscale.com/stable/${name}.sha256`);
    if (!response.ok) throw new Error(`Could not fetch the published checksum for ${name}.`);
    checksums[name] = (await response.text()).trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  }
  return checksums;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "archive") {
    const [runtimeDirectory, outputDirectory, version, platform, arch] = args;
    if (!runtimeDirectory || !outputDirectory || !version || !platform || !arch) {
      throw new Error(
        "Usage: package-remote archive <runtime-dir> <output-dir> <version> <platform> <arch>",
      );
    }
    const archive = packageRemoteArchive({
      runtimeDirectory: NodePath.resolve(runtimeDirectory),
      outputDirectory: NodePath.resolve(outputDirectory),
      version,
      target: remoteTargetFor(platform, arch),
      nodeBinary: process.execPath,
      license: NodePath.join(scriptsDirectory, "..", "LICENSE"),
    });
    console.log(`Packaged ${NodePath.basename(archive)}.`);
  } else if (command === "manifest") {
    const [directory, version] = args;
    const privateKeyPem = process.env.AKERU_REMOTE_MANIFEST_SIGNING_KEY?.trim();
    if (!directory || !version) throw new Error("Usage: package-remote manifest <dir> <version>");
    if (!privateKeyPem) throw new Error("AKERU_REMOTE_MANIFEST_SIGNING_KEY is required.");
    for (const installer of REMOTE_INSTALLERS) {
      NodeFS.copyFileSync(
        NodePath.join(scriptsDirectory, installer),
        NodePath.join(directory, installer),
      );
    }
    writeRemoteManifest({
      directory: NodePath.resolve(directory),
      version,
      privateKeyPem: `${privateKeyPem}\n`,
      externalChecksums: await fetchTailscaleChecksums(),
    });
    console.log(`Signed ${REMOTE_MANIFEST}.`);
  } else {
    throw new Error("Usage: package-remote {archive|manifest} ...");
  }
}
