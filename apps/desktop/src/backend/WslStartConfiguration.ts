import * as Result from "effect/Result";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Option from "effect/Option";

import serverPackageJson from "../../../server/package.json" with { type: "json" };
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";
import {
  type SharedBootstrapInput,
  buildObservabilityFragment,
  backendChildEnvPatch,
} from "./BackendBootstrapConfig.ts";

// Sensitive env vars that the WSL backend needs but Windows process.env won't
// forward across the wsl.exe boundary without WSLENV. The dev-server URL is
// handled separately via a `--dev-url` CLI flag because WSLENV translation of
// URL-shaped values (colons / slashes) is unreliable.
export const WSL_FORWARDED_ENV_NAMES = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

export const WSL_SERVER_SYSTEM_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const getWslEnvEntryName = (entry: string): string => {
  const slashIndex = entry.indexOf("/");

  return slashIndex === -1 ? entry : entry.slice(0, slashIndex);
};

export const mergeWslEnv = (
  existingWslEnv: string | undefined,
  forwardedEnvNames: ReadonlyArray<string>,
): string | undefined => {
  const existing = existingWslEnv?.trim() ?? "";

  // Names already declared, so we don't forward a duplicate. We parse the
  // existing value only for this membership test — the string itself is
  // preserved verbatim below rather than re-serialized.
  const seenNames = new Set(
    existing
      .split(":")
      .map((entry) => getWslEnvEntryName(entry.trim()))
      .filter((name) => name.length > 0),
  );

  const additions = forwardedEnvNames.filter((name) => !seenNames.has(name));

  // Preserve the user's WSLENV exactly as Windows handed it to us — empty
  // "::" segments and duplicate entries are harmless no-ops to WSL and not
  // ours to normalize — and only append the secrets we need to forward
  // across the wsl.exe boundary.
  const parts = [existing, ...additions].filter((part) => part.length > 0);

  return parts.length > 0 ? parts.join(":") : undefined;
};

export interface WslPreflightSuccess {
  readonly _tag: "Ready";
  readonly runningDistro: string;
  readonly linuxEntryPath: string;
  // Absolute path to the node binary the preflight validated after the shared
  // remote resolver repaired PATH. The launch must use this exact path so it
  // doesn't fall through to a different/old node than the one node-pty was
  // built against.
  readonly nodePath: string;
  // PATH captured from the same login shell after the shared resolver loaded
  // version managers. The launch forwards this value directly without a shell.
  readonly resolvedPath: string;
}

export interface WslPreflightFailure {
  readonly _tag: "Failed";
  readonly reason: string;
  // Fatal: the WSL distro is misconfigured (no node, wrong version, missing
  // build tools) and retrying won't help — surface it and (wsl-only) fall back
  // to Windows. Non-fatal: transient (WSL not ready yet, wslpath while it
  // boots), with a bounded window for self-healing before fallback.
  readonly fatal: boolean;
  readonly retryLimit?: number;
}

const WslPreflight = Data.taggedEnum<WslPreflightSuccess | WslPreflightFailure>();

export const WSL_TRANSIENT_PREFLIGHT_RETRY_LIMIT = 12;

export const runWslPreflight = Effect.fn("desktop.backendConfiguration.wslPreflight")(
  function* (input: {
    readonly distro: string | null;
    readonly windowsEntryPath: string;
    readonly windowsRepoRoot: string;
    readonly allowBuild: boolean;
  }): Effect.fn.Return<
    WslPreflightSuccess | WslPreflightFailure,
    never,
    DesktopWslEnvironment.DesktopWslEnvironment | FileSystem.FileSystem
  > {
    const wslEnv = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;

    const wslAvailable = yield* wslEnv.isAvailable;

    if (!wslAvailable) {
      return WslPreflight.Failed({ reason: "WSL is not available on this system", fatal: false });
    }

    const distroProbe = yield* wslEnv.probeDistros.pipe(Effect.result);

    if (Result.isFailure(distroProbe)) {
      return WslPreflight.Failed({
        reason: `Unable to list WSL distributions: ${distroProbe.failure.message}`,
        fatal: false,
      });
    }

    const installedDistros = distroProbe.success;

    const runningDistro = input.distro
      ? (installedDistros.find(
          (installed) => installed.name.toLowerCase() === input.distro?.toLowerCase(),
        )?.name ?? null)
      : (installedDistros.find((installed) => installed.isDefault)?.name ?? null);

    if (runningDistro === null) {
      return WslPreflight.Failed({
        reason: input.distro
          ? `WSL distro is not installed: ${input.distro}`
          : installedDistros.length === 0
            ? "WSL has no installed distributions"
            : "WSL has no default distribution",
        fatal: true,
      });
    }

    const entryExists = yield* fileSystem
      .exists(input.windowsEntryPath)
      .pipe(Effect.orElseSucceed(() => false));

    if (!entryExists) {
      return WslPreflight.Failed({
        reason: `missing server entry at ${input.windowsEntryPath}`,
        fatal: true,
      });
    }

    const linuxEntry = yield* wslEnv.windowsToWslPath(runningDistro, input.windowsEntryPath);

    if (Option.isNone(linuxEntry)) {
      return WslPreflight.Failed({
        reason: `wslpath conversion failed for ${input.windowsEntryPath}`,
        fatal: false,
      });
    }

    const nodePtyResult = yield* wslEnv.ensureNodePty(runningDistro, input.windowsRepoRoot, {
      allowBuild: input.allowBuild,
      nodeEngineRange: serverPackageJson.engines.node,
    });

    if (!nodePtyResult.ok) {
      return WslPreflight.Failed({
        reason: `WSL node-pty unavailable: ${nodePtyResult.reason}`,
        fatal: nodePtyResult.fatal,
        ...(nodePtyResult.retryLimit === undefined ? {} : { retryLimit: nodePtyResult.retryLimit }),
      });
    }

    return WslPreflight.Ready({
      runningDistro,
      linuxEntryPath: linuxEntry.value,
      nodePath: nodePtyResult.nodePath,
      resolvedPath: nodePtyResult.resolvedPath,
    });
  },
);

// True when the given IPv4 belongs to a Windows-side network
// export interface. In WSL2 mirrored mode the distro's eth0 IP equals the
// host's, which is the signature we use to detect that mode and
// switch the renderer URL to loopback.
const isLocalHostIpv4 = (ip: string): boolean => {
  const interfaces = NodeOS.networkInterfaces();

  for (const list of Object.values(interfaces)) {
    if (!list) continue;

    for (const entry of list) {
      // os.networkInterfaces() reports IPv4 `family` as the string "IPv4" on
      // the Node build Electron ships (41 / Node 22, verified), but some Node
      // builds report the numeric 4. Normalize to a string so a future runtime
      // bump can't silently break mirrored-mode detection and leave the
      // renderer pointed at the distro IP instead of loopback.
      const family = String(entry.family);

      if ((family === "IPv4" || family === "4") && entry.address === ip) return true;
    }
  }

  return false;
};

export const resolveWslStartConfig = Effect.fn("desktop.backendConfiguration.resolveWsl")(
  function* (
    input: SharedBootstrapInput & {
      readonly port: number;
      readonly distro: string | null;
    },
  ): Effect.fn.Return<
    DesktopBackendManager.DesktopBackendStartConfig,
    never,
    | DesktopEnvironment.DesktopEnvironment
    | DesktopWslEnvironment.DesktopWslEnvironment
    | DesktopWslServerTree.DesktopWslServerTree
    | FileSystem.FileSystem
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const wslServerTree = yield* DesktopWslServerTree.DesktopWslServerTree;

    // Bind to 0.0.0.0 inside WSL so the backend is reachable both via
    // WSL2's automatic localhost forwarding (wslhost: Windows 127.0.0.1
    // -> WSL 127.0.0.1) AND via the distro's eth0 IP directly from
    // Windows. wslhost forwarding is unreliable on some Windows hosts:
    // the desktop's readiness probe and the renderer's saved-env-style
    // fetch both saw "Failed to fetch" when the backend only bound to
    // 127.0.0.1 inside WSL. Binding to 0.0.0.0 plus advertising the
    // WSL IP as the renderer-visible URL avoids that dependency.
    // Security-wise this is acceptable for the local-only WSL backend:
    // the network it exposes on is the WSL-vEthernet network, not the
    // LAN; the primary owns LAN exposure when the user opts in.
    const wslBindHost = "0.0.0.0";

    const bootstrap = {
      mode: "desktop" as const,
      noBrowser: true,
      port: input.port,
      // Omit t3Home so the Linux backend uses its own home dir instead of
      // the Windows-side baseDir (which would be a /mnt/c path and share
      // the SQLite file with the primary).
      host: wslBindHost,
      desktopBootstrapToken: input.bootstrapToken,
      // PortSchema rejects 0, so when tailscale serve is disabled we still
      // need a valid number in this slot. The backend reads tailscaleServePort
      // only when tailscaleServeEnabled is true, so the actual value here is
      // inert.
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      // The packaged sidecar is a Windows executable and cannot run inside the
      // Linux WSL backend. Keep the field absent instead of passing an unusable
      // `/mnt/.../*.exe` path; WSL resource telemetry is reported unavailable.
      // See docs/architecture/resource-telemetry.md.
      ...buildObservabilityFragment(input.observabilitySettings),
    };

    // In packaged builds the server tree ships inside resources/server.asar —
    // an archive FILE the Windows primary reads through ELECTRON_RUN_AS_NODE
    // (asar-aware). The WSL backend launches plain `wsl.exe -- node`, which
    // can't read an asar, so materialize (or reuse) the extracted copy of the
    // sidecar before preflighting. In dev the server tree is the real checkout
    // directory and ensure returns it unchanged.
    const serverTree = yield* wslServerTree.ensure;
    const wslAppRoot = serverTree.ok ? serverTree.root : environment.serverRoot;
    const wslEntryPath = environment.path.join(wslAppRoot, "apps/server/dist/bin.mjs");

    const preflight = serverTree.ok
      ? yield* runWslPreflight({
          distro: input.distro,
          windowsEntryPath: wslEntryPath,
          windowsRepoRoot: wslAppRoot,
          // Packaged builds ship a prebuilt Linux node-pty (built on Linux in CI and
          // attached to the Windows artifact — see build-desktop-artifact.ts), so the
          // WSL backend never needs a compiler, node-gyp, or network on first launch.
          // Compiling from source is a dev-only convenience: a checkout has no shipped
          // prebuilt, and developers have the toolchain. In packaged builds we instead
          // surface a clear diagnostic if the prebuilt can't load (unsupported
          // arch/distro), rather than silently dropping into a fragile runtime build.
          allowBuild: !environment.isPackaged,
        })
      : WslPreflight.Failed({ reason: serverTree.reason, fatal: serverTree.fatal });

    // Every operation after preflight uses the same concrete distro. In
    // default-tracking mode this closes the race where the system default
    // changes between probing and spawning the backend.
    const runningDistro = Predicate.isTagged(preflight, "Ready") ? preflight.runningDistro : null;
    const distroForConfig = runningDistro ?? input.distro;

    // Resolve the selected distro's IPv4 address. In mirrored mode the distro
    // reports a host interface, so use loopback instead; a failed probe also
    // falls back to loopback and preserves the previous behavior.
    const distroIp = yield* wslEnvironment.getDistroIp(distroForConfig);

    const usesSharedNetworkStack = Option.match(distroIp, {
      onNone: () => false,
      onSome: (ip) => isLocalHostIpv4(ip),
    });

    const rendererHost = usesSharedNetworkStack
      ? "127.0.0.1"
      : Option.getOrElse(distroIp, () => "127.0.0.1");

    const httpBaseUrl = new URL(`http://${rendererHost}:${input.port}`);

    const distroArgs = distroForConfig ? ["-d", distroForConfig] : [];
    const forwardedEnv: Record<string, string> = {};
    const forwardedEnvNames: string[] = [];

    for (const name of WSL_FORWARDED_ENV_NAMES) {
      const value = process.env[name];

      if (value !== undefined && value.length > 0) {
        forwardedEnv[name] = value;
        forwardedEnvNames.push(name);
      }
    }

    // Build an explicit copy of process.env minus AKERU_HOME/T3CODE_HOME (dev-runner
    // exports the Windows-side base dir for the primary; if it leaks into
    // the WSL backend the Linux side ends up sharing C:\Users\...\.t3 via
    // /mnt/c, which means both backends read/write the same database and
    // their env-ids collide).
    const parentEnvWithoutT3Home: Record<string, string | undefined> = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (key === "AKERU_HOME" || key === "T3CODE_HOME") continue;
      parentEnvWithoutT3Home[key] = value;
    }

    const wslEnv = mergeWslEnv(parentEnvWithoutT3Home.WSLENV, forwardedEnvNames);

    const baseConfig = {
      executablePath: "wsl.exe",
      entryPath: wslEntryPath,
      cwd: environment.backendCwd,
      env: {
        ...parentEnvWithoutT3Home,
        ...backendChildEnvPatch(),
        ...forwardedEnv,
        ...(wslEnv !== undefined ? { WSLENV: wslEnv } : {}),
      },
      // env is already a complete process.env minus the home variables; pass it
      // verbatim instead of letting the spawner re-merge process.env on top.
      extendEnv: false,
      bootstrap,
      bootstrapDelivery: "stdin" as const,
      httpBaseUrl,
      captureOutput: true,
      ...(runningDistro !== null ? { runningDistro } : {}),
    };

    // Forward the dev-server URL as an explicit CLI flag so the WSL backend's
    // config resolution lands in dev/ instead of userdata/. Inheriting through
    // WSLENV is unreliable in practice (URL-shaped values with colons /
    // slashes get translated unpredictably depending on flags), and the
    // packaged build leaves devServerUrl as None anyway.
    const devUrlArgs = Option.match(environment.devServerUrl, {
      onNone: (): string[] => [],
      onSome: (url) => ["--dev-url", url.href],
    });

    if (Predicate.isTagged(preflight, "Failed")) {
      const retryLimit =
        preflight.retryLimit ?? (preflight.fatal ? undefined : WSL_TRANSIENT_PREFLIGHT_RETRY_LIMIT);

      return {
        ...baseConfig,
        args: [...distroArgs, "--", "node", "--version"],
        preflightFailure: Option.some({
          reason: preflight.reason,
          fatal: preflight.fatal,
          ...(retryLimit === undefined ? {} : { retryLimit }),
        }),
      } satisfies DesktopBackendManager.DesktopBackendStartConfig;
    }

    // The WSL server spawns commands its providers reference by name — `npm`/`npx`
    // for provider updates, and the installed CLIs themselves (e.g. `codex`). Those
    // live in the resolved Node's bin dir, which `wsl.exe -- node` does NOT put on
    // the process PATH, so `npm install -g ...` fails with NotFound. Pass the
    // user PATH entries captured by the login-shell preflight. Every dynamic
    // value is a separate argv entry under `wsl.exe --exec`; no shell command is
    // involved, so Windows cannot mangle nested quotes and stdin remains reserved
    // for the bootstrap envelope.
    const lastSlash = preflight.nodePath.lastIndexOf("/");
    const nodeBinDir = lastSlash > 0 ? preflight.nodePath.slice(0, lastSlash) : "/usr/bin";
    const launchPath = `${nodeBinDir}:${WSL_SERVER_SYSTEM_PATH}:${preflight.resolvedPath}`;

    return {
      ...baseConfig,
      args: [
        ...distroArgs,
        "--exec",
        "env",
        `PATH=${launchPath}`,
        preflight.nodePath,
        preflight.linuxEntryPath,
        "--bootstrap-fd",
        "0",
        ...devUrlArgs,
      ],
      preflightFailure: Option.none(),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  },
);
