import * as Duration from "effect/Duration";

import * as Effect from "effect/Effect";

import * as Option from "effect/Option";

import { ChildProcessSpawner } from "effect/unstable/process";

import { satisfiesSemverRange } from "@akeru/shared/semver";

import {
  type EnsureWslNodePtyOptions,
  formatWslShellTransportFailureReason,
  runWslShell,
  shellQuote,
} from "./WslShell.ts";

const PROBE_TIMEOUT = Duration.seconds(10);

const TOOLCHAIN_TIMEOUT = Duration.seconds(10);

const BUILD_TIMEOUT = Duration.minutes(5);

const TOOLCHAIN_TRANSPORT_RETRY_LIMIT = 12;

const BUILD_TRANSPORT_RETRY_LIMIT = 2;

export type EnsureWslNodePtyResult =
  | {
      readonly ok: true;
      readonly nodePath: string;
      readonly resolvedPath: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly fatal: boolean;
      readonly retryLimit?: number;
    };

const NODE_PTY_PREBUILD_MISSING_EXIT_CODE = 4;

export const formatNodePtyProbeFailureReason = (exitCode: number): string | null =>
  exitCode === NODE_PTY_PREBUILD_MISSING_EXIT_CODE
    ? "WSL support is missing from this Akeru Bot build: the packaged Linux node-pty binary was not included. Rebuild the Windows artifact with `--wsl-prebuild <path-to-linux-pty.node>` or install a build that includes WSL support."
    : null;

const NODE_PTY_PROBE_SCRIPT = (
  linuxServerDir: string,
) => `printf 'nodePath:%s\\n' "$(command -v node 2>/dev/null)"
printf 'nodeVersion:%s\\n' "$(node -p 'process.versions.node' 2>/dev/null)"
printf 'resolvedPath:%s\\n' "$PATH"
cd ${shellQuote(linuxServerDir)} && node <<'NODE' >/dev/null 2>&1
// The WSL Node can't read inside app.asar, so confirm what the server needs is
// unpacked on the real filesystem before reporting the backend healthy. Exit 3
// marks this distinct from a node-pty prebuild problem so the caller can report
// it accurately instead of letting the server crash on ERR_MODULE_NOT_FOUND at
// launch (which, in wsl-only mode, would just fail to launch with no fallback).
//
// The sentinel must be a package the CLI bundle leaves external. It used to be
// "effect", back when the bundle externalized its runtime deps and the whole
// node_modules tree was unpacked. The bundle now inlines its JS dependencies,
// so "effect" no longer exists on disk and only the native packages do —
// resolving node-pty is what actually validates the unpacked tree.
try { require.resolve("node-pty/package.json"); } catch (_e) { process.exit(3); }
const fs = require("node:fs");
const path = require("node:path");
const pkgDir = path.dirname(require.resolve("node-pty/package.json"));
// node-pty 1.x is N-API based, so a single Linux pty.node is ABI-stable across
// Node versions — require() succeeding IS the real compatibility test. Compare
// only arch and node-pty version (a stale binary from a different node-pty),
// NOT process.versions.modules: that would reject a perfectly loadable prebuilt
// whenever the user's WSL Node ABI differs from the build's, defeating the
// whole point of shipping one prebuilt for all Node versions.
const expected = {
  arch: process.arch,
  nodePtyVersion: require("node-pty/package.json").version,
};
const prebuildDir = path.join(pkgDir, "prebuilds", "linux-" + process.arch);
const marker = path.join(prebuildDir, "t3code-wsl-node-pty.json");
const binary = path.join(prebuildDir, "pty.node");
if (!fs.existsSync(marker) || !fs.existsSync(binary)) process.exit(${NODE_PTY_PREBUILD_MISSING_EXIT_CODE});
require("node-pty");
const actual = JSON.parse(fs.readFileSync(marker, "utf8"));
for (const key of Object.keys(expected)) {
  if (actual[key] !== expected[key]) process.exit(2);
}
NODE`;

const TOOLCHAIN_CHECK_SCRIPT = [
  "for tool in node make g++ python3; do",
  '  command -v "$tool" >/dev/null 2>&1 || echo "missing:$tool"',
  "done",
  "if command -v node >/dev/null 2>&1; then",
  `  ver="$(node -p 'process.versions.node' 2>/dev/null)"`,
  '  if [ -n "$ver" ]; then printf "nodeVersion:%s\\n" "$ver"; fi',
  "fi",
].join("\n");

const NODE_PTY_BUILD_SCRIPT = (linuxServerDir: string) =>
  [
    "set -e",
    `cd ${shellQuote(linuxServerDir)}`,
    `pkg_dir=$(node -p "require('node:path').dirname(require.resolve('node-pty/package.json'))")`,
    `arch=$(node -p "process.arch")`,
    `modules=$(node -p "process.versions.modules")`,
    `node_pty_version=$(node -p "require('node-pty/package.json').version")`,
    `cd "$pkg_dir"`,
    "npx --yes node-gyp rebuild",
    `prebuild_dir="prebuilds/linux-$arch"`,
    `mkdir -p "$prebuild_dir"`,
    `cp build/Release/pty.node "$prebuild_dir/pty.node"`,
    `printf '{"arch":"%s","modules":"%s","nodePtyVersion":"%s"}\\n' "$arch" "$modules" "$node_pty_version" > "$prebuild_dir/t3code-wsl-node-pty.json"`,
    `node -e 'require("node-pty")'`,
  ].join("\n");

export interface ToolchainReport {
  readonly missingTools: ReadonlyArray<string>;
  readonly nodeVersion: string | null;
}

export const parseToolchainReport = (stdout: string): ToolchainReport => {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const missingTools = lines
    .filter((line) => line.startsWith("missing:"))
    .map((line) => line.slice("missing:".length));

  const nodeVersionLine = lines.find((line) => line.startsWith("nodeVersion:"));

  const nodeVersion = nodeVersionLine
    ? nodeVersionLine.slice("nodeVersion:".length).trim() || null
    : null;

  return { missingTools, nodeVersion };
};

// Pulls the absolute node path the WSL distro resolved after the shared remote
// resolver repaired PATH. Returns null when no node was found, which the caller
// turns into an actionable "install Node" message instead of a confusing
// node-pty error.
export const parseNodePath = (stdout: string): string | null => {
  const path = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("nodePath:"))
    .map((line) => line.slice("nodePath:".length).trim())
    .find((value) => value.length > 0);

  return path ?? null;
};

export const parseNodeVersion = (stdout: string): string | null => {
  const version = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("nodeVersion:"))
    .map((line) => line.slice("nodeVersion:".length).trim())
    .find((value) => value.length > 0);

  return version ?? null;
};

// Captures the login-shell PATH after the shared resolver has loaded version
// managers. Preserve the value byte-for-byte apart from a Windows-style CR so
// paths containing spaces or apostrophes can be forwarded as one env argv.
export const parseResolvedPath = (stdout: string): string | null => {
  const prefix = "resolvedPath:";
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(prefix));

  if (line === undefined) return null;
  const resolvedPath = line.slice(prefix.length).replace(/\r$/, "");

  return resolvedPath.length > 0 ? resolvedPath : null;
};

export const formatMissingToolsReason = (
  report: ToolchainReport,
  requiredRange: string | null,
): string | null => {
  const nodeMissing = report.missingTools.includes("node");

  const nodeOutOfRange =
    !nodeMissing &&
    requiredRange !== null &&
    report.nodeVersion !== null &&
    !satisfiesSemverRange(report.nodeVersion, requiredRange);

  const buildToolsMissing = report.missingTools.filter((tool) => tool !== "node");

  if (!nodeMissing && !nodeOutOfRange && buildToolsMissing.length === 0) {
    return null;
  }

  const issues: string[] = [];
  const remediations: string[] = [];

  if (nodeMissing) {
    issues.push("node");
    remediations.push(
      `Node.js${requiredRange ? ` satisfying \`${requiredRange}\`` : " 18+"} (e.g. via nvm)`,
    );
  } else if (nodeOutOfRange) {
    issues.push(`node ${report.nodeVersion} (requires ${requiredRange})`);
    remediations.push(
      `a newer Node.js satisfying \`${requiredRange}\` (e.g. \`nvm install 24 && nvm alias default 24\`)`,
    );
  }

  if (buildToolsMissing.length > 0) {
    issues.push(...buildToolsMissing);
    remediations.push(
      "the build toolchain (e.g. `sudo apt install -y build-essential python3` on Ubuntu/Debian)",
    );
  }

  return `WSL distro is missing required tools: ${issues.join(", ")}. Install ${remediations.join(" and ")}, then retry.`;
};

export const ensureNodePtyImpl = (
  distro: string | null,
  windowsRepoRoot: string,
  windowsToWslPath: (
    distro: string | null,
    windowsPath: string,
  ) => Effect.Effect<Option.Option<string>>,
  options: EnsureWslNodePtyOptions = {},
): Effect.Effect<EnsureWslNodePtyResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const linuxRepoRootOption = yield* windowsToWslPath(distro, windowsRepoRoot);

    if (Option.isNone(linuxRepoRootOption)) {
      return {
        ok: false,
        reason: `wslpath conversion failed for ${windowsRepoRoot}`,
        fatal: false,
      } as const;
    }

    const linuxRepoRoot = linuxRepoRootOption.value;
    // node-pty lives in the apps/server workspace's node_modules; resolve from
    // there rather than the monorepo root, where Bun's hoist layout omits it.
    const linuxServerDir = `${linuxRepoRoot}/apps/server`;

    const probe = yield* runWslShell(
      distro,
      NODE_PTY_PROBE_SCRIPT(linuxServerDir),
      PROBE_TIMEOUT,
      options,
    );

    const nodePath = parseNodePath(probe.stdout);
    const resolvedPath = parseResolvedPath(probe.stdout);

    const transportFailureReason = formatWslShellTransportFailureReason(probe.transportFailure);

    if (transportFailureReason !== null) {
      return {
        ok: false,
        reason: transportFailureReason,
        fatal: false,
      } as const;
    }

    // No node at all, even after the shared resolver repaired PATH. Surface
    // the specific, actionable toolchain message rather than a confusing
    // node-pty error, and don't try to build.
    if (nodePath === null) {
      const toolchainCheck = yield* runWslShell(
        distro,
        TOOLCHAIN_CHECK_SCRIPT,
        TOOLCHAIN_TIMEOUT,
        options,
      );

      const toolchainTransportFailure = formatWslShellTransportFailureReason(
        toolchainCheck.transportFailure,
      );

      if (toolchainTransportFailure !== null) {
        return {
          ok: false,
          reason: toolchainTransportFailure,
          fatal: false,
          retryLimit: TOOLCHAIN_TRANSPORT_RETRY_LIMIT,
        } as const;
      }

      const report = parseToolchainReport(toolchainCheck.stdout);

      const reason =
        formatMissingToolsReason(report, options.nodeEngineRange?.trim() || null) ??
        "Node.js was not found in the WSL distro. Install it (e.g. via nvm) and restart the desktop app.";

      return { ok: false, reason, fatal: true } as const;
    }

    if (resolvedPath === null) {
      return {
        ok: false,
        reason: "WSL login-shell PATH could not be resolved during backend preflight.",
        fatal: true,
      } as const;
    }

    // The packages the server bundle leaves external (node-pty and the other
    // native addons) couldn't be resolved on the WSL filesystem — a packaging
    // regression, since those must be unpacked from the asar. Fatal so wsl-only
    // mode falls back to Windows and dual mode surfaces the reason inline,
    // instead of the server crash-looping on ERR_MODULE_NOT_FOUND once it
    // actually launches.
    if (probe.exitCode === 3) {
      return {
        ok: false,
        reason:
          'WSL server dependencies could not be loaded (for example "node-pty"). The native packages the server needs are not unpacked where the WSL distro\'s Node can read them — this is a packaging problem with this build. Please report it.',
        fatal: true,
      } as const;
    }

    if (probe.exitCode === 0) {
      const rawVersion = parseNodeVersion(probe.stdout);

      if (
        rawVersion !== null &&
        options.nodeEngineRange &&
        !satisfiesSemverRange(rawVersion, options.nodeEngineRange.trim())
      ) {
        const range = options.nodeEngineRange.trim();

        return {
          ok: false,
          reason: `WSL Node.js ${rawVersion} does not satisfy the server's required engine range (${range}). Install a compatible version, and restart the desktop app.`,
          fatal: true,
        } as const;
      }

      return { ok: true, nodePath, resolvedPath } as const;
    }

    if (options.allowBuild !== true) {
      const packagedProbeFailure = formatNodePtyProbeFailureReason(probe.exitCode);

      if (packagedProbeFailure !== null) {
        return {
          ok: false,
          reason: packagedProbeFailure,
          fatal: true,
        } as const;
      }
    }

    // node is present but node-pty's native module didn't load.
    const toolchainCheck = yield* runWslShell(
      distro,
      TOOLCHAIN_CHECK_SCRIPT,
      TOOLCHAIN_TIMEOUT,
      options,
    );

    const toolchainTransportFailure = formatWslShellTransportFailureReason(
      toolchainCheck.transportFailure,
    );

    if (toolchainTransportFailure !== null) {
      return {
        ok: false,
        reason: toolchainTransportFailure,
        fatal: false,
        retryLimit: TOOLCHAIN_TRANSPORT_RETRY_LIMIT,
      } as const;
    }

    const report = parseToolchainReport(toolchainCheck.stdout);

    if (options.allowBuild !== true) {
      // Packaged builds ship a prebuilt Linux node-pty, so no compiler, node-gyp,
      // or network is needed — and we must not nag the user to install build
      // tools they don't need. Still surface a missing/too-old Node (both the
      // prebuilt and the server require a compatible Node); otherwise reaching
      // here means the bundled binary itself couldn't load, which is almost
      // always an unsupported CPU architecture or incompatible system libraries.
      const nodeOnlyReason = formatMissingToolsReason(
        {
          missingTools: report.missingTools.filter((tool) => tool === "node"),
          nodeVersion: report.nodeVersion,
        },
        options.nodeEngineRange?.trim() || null,
      );

      return {
        ok: false,
        reason:
          nodeOnlyReason ??
          "The bundled WSL backend binary (node-pty) could not be loaded in this distro. This usually means an unsupported CPU architecture or incompatible system libraries (glibc). Use a glibc-based x64/arm64 WSL distro such as Ubuntu; if you already are, please report this with your distro and the output of `uname -m`.",
        fatal: true,
      } as const;
    }

    // Dev only: no prebuilt is bundled in a checkout, so compile node-pty from
    // source. Run the toolchain check first so a missing compiler or out-of-range
    // Node surfaces a specific, actionable message instead of an opaque node-gyp
    // failure. Developers have the toolchain; end users never reach this path.
    const missingReason = formatMissingToolsReason(report, options.nodeEngineRange?.trim() || null);

    if (missingReason !== null) {
      return { ok: false, reason: missingReason, fatal: true } as const;
    }

    const build = yield* runWslShell(
      distro,
      NODE_PTY_BUILD_SCRIPT(linuxServerDir),
      BUILD_TIMEOUT,
      options,
    );

    const buildTransportFailure = formatWslShellTransportFailureReason(build.transportFailure);

    if (buildTransportFailure !== null) {
      return {
        ok: false,
        reason: buildTransportFailure,
        fatal: false,
        retryLimit: BUILD_TRANSPORT_RETRY_LIMIT,
      } as const;
    }

    if (build.exitCode === 0) return { ok: true, nodePath, resolvedPath } as const;
    const trimmedTail = `${build.stdout}${build.stderr}`.trim().slice(-500);

    return {
      ok: false,
      reason: `node-pty Linux build failed (exit ${build.exitCode}): ${trimmedTail || "no stderr captured"}`,
      fatal: true,
    } as const;
  });
