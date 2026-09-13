#!/usr/bin/env node

import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PRODUCT_HOME_DIRNAME,
  resolveGitWorktreePath,
  resolveWorktreeT3Home,
} from "@t3tools/shared/devHome";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { loadRepoEnv } from "./lib/public-config.ts";

// Read the existing server-runtime.json without importing server implementation code.
const decodeRuntime = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      pid: Schema.Int,
      origin: Schema.String,
      devUrl: Schema.optional(Schema.String),
    }),
  ),
);

export const resolveDevStatusHome = Effect.fn("resolveDevStatusHome")(function* (input: {
  readonly cwd: string;
  readonly homeDir?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userHome: string;
}) {
  const path = yield* Path.Path;
  const worktree = yield* resolveGitWorktreePath(input.cwd);
  const worktreeHome = yield* resolveWorktreeT3Home(input.cwd);
  const selected = input.homeDir?.trim() || worktreeHome || input.env.T3CODE_HOME?.trim();
  const expanded =
    selected === "~"
      ? input.userHome
      : selected?.startsWith("~/") || selected?.startsWith("~\\")
        ? path.join(input.userHome, selected.slice(2))
        : selected;
  const home = expanded
    ? path.resolve(input.cwd, expanded)
    : path.join(input.userHome, PRODUCT_HOME_DIRNAME);
  return { worktree, home, dataDir: path.join(home, selected ? "userdata" : "dev") };
});

export function statusOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function isStatusProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Probe only numeric loopback addresses, without credentials or redirects. */
export const probeStatusOrigin = Effect.fn("probeStatusOrigin")(function* (origin: string) {
  const safe = statusOrigin(origin);
  if (!safe) return "unknown (invalid HTTP origin)";
  const url = new URL(safe);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return "unknown (non-loopback; not checked)";
  }
  const hosts = url.hostname === "localhost" ? ["127.0.0.1", "[::1]"] : [url.hostname];
  for (const host of hosts) {
    const target = new URL(url);
    target.hostname = host;
    const result = yield* HttpClient.head(target).pipe(
      Effect.timeout("1500 millis"),
      Effect.map(
        (response) =>
          `HTTP ${String(response.status)} (responding; application readiness unverified)`,
      ),
      Effect.option,
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
      }),
    );
    if (Option.isSome(result)) return result.value;
  }
  return "unavailable (loopback HTTP check failed)";
});

export function describeStatusClients(env: Readonly<Record<string, string | undefined>>) {
  const debugPort = env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
  const validDebugPort =
    debugPort && /^\d+$/.test(debugPort) && Number(debugPort) > 0 && Number(debugPort) <= 65535;
  return {
    desktop: `${validDebugPort ? `debug port ${String(Number(debugPort))} configured` : debugPort ? "invalid debug port" : "debug port not configured"}; running unknown`,
    mobile:
      "installed/running unknown; resolve development identity with node .agents/skills/test-t3-mobile/scripts/app-identity.mjs <scheme|ios-bundle-id|android-package>",
  };
}

export const collectDevStatus = Effect.fn("collectDevStatus")(function* (input: {
  readonly cwd: string;
  readonly homeDir?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly probe?: (origin: string) => Effect.Effect<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let root = path.resolve(input.cwd);
  while (!(yield* fs.exists(path.join(root, ".git")))) {
    const parent = path.dirname(root);
    if (parent === root) break;
    root = parent;
  }
  const hasRoot = yield* fs.exists(path.join(root, ".git"));
  if (!hasRoot) root = path.resolve(input.cwd);
  const env = input.env ?? loadRepoEnv({ repoRoot: root });
  const home = yield* resolveDevStatusHome({
    ...input,
    env,
    userHome: input.userHome ?? NodeOS.homedir(),
  });
  const runtimePath = path.join(home.dataDir, "server-runtime.json");
  const tracePath = path.join(home.dataDir, "logs", "server.trace.ndjson");
  // Decode diagnostics can contain file contents; status must never print them.
  const runtime = yield* fs
    .readFileString(runtimePath)
    .pipe(Effect.flatMap(decodeRuntime), Effect.option);
  const missing: string[] = [];
  if (!hasRoot) missing.push("Git checkout root not found");
  if (!(yield* fs.exists(path.join(root, "node_modules"))))
    missing.push("dependencies (node_modules)");
  if (Number(process.versions.node.split(".")[0]) < 24) missing.push("Node 24 or newer");
  if (!(yield* fs.exists(home.dataDir))) missing.push("data directory");
  // Desktop artifacts are optional for web-only development; report them separately.
  const desktopArtifactsMissing: string[] = [];
  for (const artifact of [
    "apps/desktop/dist-electron/main.cjs",
    "apps/desktop/dist-electron/preload.cjs",
    "apps/server/dist/bin.mjs",
  ]) {
    if (!(yield* fs.exists(path.join(root, artifact)))) desktopArtifactsMissing.push(artifact);
  }
  const tracePresent = yield* fs.exists(tracePath);
  const clients = describeStatusClients(env);
  let descriptor = "missing, empty, invalid, or unreadable; running unknown";
  let serverOrigin: string | undefined;
  let webOrigin: string | undefined;
  let serverReadiness = "unknown (no usable runtime descriptor)";
  let webReadiness = serverReadiness;
  if (Option.isSome(runtime)) {
    const state = runtime.value;
    serverOrigin = statusOrigin(state.origin);
    webOrigin = statusOrigin(state.devUrl);
    const alive = (input.isProcessAlive ?? isStatusProcessAlive)(state.pid);
    descriptor = alive
      ? `pid ${String(state.pid)} exists (identity unverified)`
      : `stale (pid ${String(state.pid)} is absent or invalid)`;
    const probe = input.probe ?? probeStatusOrigin;
    const recordedServerOrigin = serverOrigin;
    const recordedWebOrigin = webOrigin;
    serverReadiness = !alive
      ? "unavailable (stale descriptor)"
      : recordedServerOrigin
        ? yield* probe(recordedServerOrigin)
        : "unknown (invalid recorded origin)";
    webReadiness = !alive
      ? "unknown (stale descriptor; not checked)"
      : recordedWebOrigin
        ? yield* probe(recordedWebOrigin)
        : "unknown (no dev web origin recorded)";
  } else {
    missing.push("usable server-runtime.json");
  }
  return {
    root,
    ...home,
    runtimePath,
    descriptor,
    server: { origin: serverOrigin, readiness: serverReadiness },
    web: { origin: webOrigin, readiness: webReadiness },
    trace: { path: tracePath, present: tracePresent },
    ...clients,
    missing,
    desktopArtifactsMissing,
  };
});

export function formatDevStatus(
  status: Effect.Success<ReturnType<typeof collectDevStatus>>,
): string {
  return [
    `Root: ${status.root}`,
    `Worktree: ${status.worktree ?? "main checkout or not a linked worktree"}`,
    `Akeru home: ${status.home}`,
    `Data directory: ${status.dataDir}`,
    `Runtime: ${status.runtimePath} — ${status.descriptor}`,
    `Server: ${status.server.origin ?? "unknown"} — ${status.server.readiness}`,
    `Web: ${status.web.origin ?? "unknown"} — ${status.web.readiness}`,
    `Trace: ${status.trace.path} (${status.trace.present ? "present" : "missing"})`,
    `Desktop: ${status.desktop}`,
    `Desktop build (optional): ${status.desktopArtifactsMissing.length ? `not built (${status.desktopArtifactsMissing.join("; ")})` : "built"}`,
    `Mobile configuration: ${status.mobile}`,
    `Missing prerequisites: ${status.missing.length ? status.missing.join("; ") : "none detected (provider and native tools not checked)"}`,
  ].join("\n");
}

const command = Command.make(
  "dev-status",
  {
    homeDir: Flag.string("home-dir").pipe(Flag.optional),
  },
  ({ homeDir }) =>
    collectDevStatus({ cwd: process.cwd(), homeDir: Option.getOrUndefined(homeDir) }).pipe(
      Effect.flatMap((status) => Console.log(formatDevStatus(status))),
    ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.catchCause(() =>
      Effect.gen(function* () {
        process.exitCode = 1;
        yield* Console.error(
          "Could not read dev status. Check local directory access and configuration.",
        );
      }),
    ),
    NodeRuntime.runMain,
  );
}
