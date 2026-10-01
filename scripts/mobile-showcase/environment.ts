// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator and emulator automation uses Node subprocess and timing APIs directly.
import * as NodeChildProcess from "node:child_process";

import * as NodeFSP from "node:fs/promises";

import * as NodeOS from "node:os";

import * as NodePath from "node:path";

import * as NodeProcess from "node:process";

import {
  type ShowcaseConfig,
  type ShowcaseDevice,
  type ShowcaseScene,
} from "../mobile-showcase.config.ts";

import { SHOWCASE_THREAD_ID } from "../mobile-showcase-environment.ts";

import { MOBILE_ROOT, APP_SCHEME, SERVER_HOST, MOBILE_BUILD_ENV } from "./paths.ts";

import { spawnProcess, runCommand, commandOutput } from "./process.ts";

interface NetworkAddress {
  readonly address: string;
  readonly family: string;
  readonly internal: boolean;
}

export function selectLanIpv4Address(addresses: ReadonlyArray<NetworkAddress>): string | null {
  return (
    addresses.find(
      ({ address, family, internal }) =>
        family === "IPv4" && !internal && !address.startsWith("169.254."),
    )?.address ?? null
  );
}

export function lanIpv4Address(): string {
  const address = selectLanIpv4Address(
    Object.values(NodeOS.networkInterfaces()).flatMap((addresses) => addresses ?? []),
  );

  if (!address) {
    throw new Error("No LAN IPv4 address is available for the iOS Simulator to reach Metro.");
  }

  return address;
}

export async function createShowcaseShell(baseDir: string): Promise<string> {
  const shellPath = NodePath.join(baseDir, "showcase-shell");
  await NodeFSP.writeFile(
    shellPath,
    `#!/bin/sh
if [ "$1" = "-ilc" ] || [ "$1" = "-lic" ]; then
  exec /bin/sh -c "$2"
fi
exec /bin/cat
`,
    { mode: 0o755 },
  );

  return shellPath;
}

export async function createShowcaseLabelProbe(baseDir: string, label: string): Promise<string> {
  const binDirectory = NodePath.join(baseDir, "showcase-bin");
  await NodeFSP.mkdir(binDirectory, { recursive: true });

  const probeScript = `#!/bin/sh
if [ "$1" = "--get" ] && [ "$2" = "ComputerName" ]; then
  printf '%s\\n' ${JSON.stringify(label)}
  exit 0
fi
if [ "$1" = "--pretty" ]; then
  printf '%s\\n' ${JSON.stringify(label)}
  exit 0
fi
exit 1
`;

  await Promise.all(
    ["scutil", "hostnamectl"].map((executable) =>
      NodeFSP.writeFile(NodePath.join(binDirectory, executable), probeScript, { mode: 0o755 }),
    ),
  );

  return binDirectory;
}

export function startShowcaseServer(
  baseDir: string,
  workspaceRoot: string,
  port: number,
  shellPath: string,
  labelProbeDirectory: string,
): NodeChildProcess.ChildProcess {
  return spawnProcess(
    "node",
    [
      "apps/server/src/bin.ts",
      "serve",
      "--host",
      SERVER_HOST,
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--no-browser",
      "--log-level",
      "error",
      workspaceRoot,
    ],
    {
      env: {
        ...NodeProcess.env,
        PATH: `${labelProbeDirectory}:${NodeProcess.env.PATH ?? ""}`,
        SHELL: shellPath,
      },
    },
  );
}

export function parsePairingCredentialOutput(output: string): string {
  const jsonStart = output.indexOf("{");
  const jsonEnd = output.lastIndexOf("}");

  if (jsonStart === -1 || jsonEnd < jsonStart) {
    throw new Error("Pairing credential command did not return JSON.");
  }

  const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as {
    readonly credential?: unknown;
  };

  if (typeof parsed.credential !== "string" || parsed.credential.length === 0) {
    throw new Error("Pairing credential command returned no credential.");
  }

  return parsed.credential;
}

export async function issuePairingCredential(baseDir: string): Promise<string> {
  const output = await commandOutput(
    "node",
    ["apps/server/src/bin.ts", "auth", "pairing", "create", "--base-dir", baseDir, "--json"],
    { env: { ...NodeProcess.env, NO_COLOR: "1" } },
  );

  return parsePairingCredentialOutput(output);
}

export function buildShowcasePairingUrl(host: string, port: number, credential: string): string {
  const url = new URL(`http://${host}:${port}/`);
  url.hash = new URLSearchParams([["token", credential]]).toString();

  return url.toString();
}

export function showcaseSceneUrl(scene: ShowcaseScene, environmentId: string): string {
  if (scene === "threads") return `${APP_SCHEME}://`;

  if (scene === "environments") return `${APP_SCHEME}://settings/environments`;
  const threadPath = `threads/${encodeURIComponent(environmentId)}/${SHOWCASE_THREAD_ID}`;

  return `${APP_SCHEME}://${threadPath}`;
}

export function encodeAndroidPairingUrls(pairingUrls: ReadonlyArray<string>): string {
  return `json-uri:${encodeURIComponent(JSON.stringify(pairingUrls))}`;
}

export function startMetro(config: ShowcaseConfig): NodeChildProcess.ChildProcess {
  return spawnProcess(
    "pnpm",
    ["exec", "expo", "start", "--dev-client", "--port", String(config.metroPort)],
    {
      cwd: MOBILE_ROOT,
      env: {
        ...MOBILE_BUILD_ENV,
        EXPO_PUBLIC_SHOWCASE: "1",
      },
    },
  );
}

export async function warmMetroBundle(
  platform: ShowcaseDevice["platform"],
  host: string,
  config: ShowcaseConfig,
): Promise<void> {
  const url = `http://${host}:${config.metroPort}/apps/mobile/index.bundle?platform=${platform}&dev=true&minify=false`;
  await runCommand("curl", ["--fail", "--silent", "--show-error", "--output", "/dev/null", url]);
}
