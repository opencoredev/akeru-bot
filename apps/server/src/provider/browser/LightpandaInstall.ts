import * as Match from "effect/Match";
import * as NodePath from "node:path";
import type { WorkspaceSandbox } from "@mastra/core/workspace";

export const LIGHTPANDA_VERSION = "0.3.7";

export interface LightpandaRelease {
  readonly url: string;
  readonly sha256: string;
}

export const LIGHTPANDA_RELEASES = {
  "darwin-arm64": {
    url: `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-aarch64-macos`,
    sha256: "ae99542d81af23087296ec037abb0d57a57002502f5ff4c1b0b05dfa484b79b8",
  },
  "darwin-x64": {
    url: `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-x86_64-macos`,
    sha256: "5e118b6e91c2cccb1ce7f0d34fc39dab262b947e4dea29a90b1a75b9399d7862",
  },
  "linux-arm64": {
    url: `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-aarch64-linux`,
    sha256: "4c0ecb28b4fcfb6d5bce82ec86e15fc6cde89cea168cf3840494f0ee26755852",
  },
  "linux-x64": {
    url: `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-x86_64-linux`,
    sha256: "895339b02205171a181dde743ae0068bb4564884076feac8482baca9c212aa5a",
  },
} as const satisfies Readonly<Record<string, LightpandaRelease>>;

export type LightpandaPlatform = keyof typeof LIGHTPANDA_RELEASES;

export function platformFromUname(system: string, machine: string): LightpandaPlatform {
  const os = system.trim().toLowerCase();
  const arch = machine.trim().toLowerCase();

  const normalizedOs = Match.value(os).pipe(
    Match.when("darwin", () => "darwin" as const),
    Match.when("linux", () => "linux" as const),
    Match.orElse(() => null),
  );

  const normalizedArch =
    arch === "arm64" || arch === "aarch64"
      ? "arm64"
      : arch === "x86_64" || arch === "amd64"
        ? "x64"
        : null;

  const key = normalizedOs && normalizedArch ? `${normalizedOs}-${normalizedArch}` : null;

  if (!key || !(key in LIGHTPANDA_RELEASES)) {
    throw new Error(`The sandbox browser does not support ${system.trim()} ${machine.trim()}.`);
  }

  // SAFETY: Membership in LIGHTPANDA_RELEASES above narrows the computed key to a supported platform.
  return key as LightpandaPlatform;
}

export async function execute(
  sandbox: WorkspaceSandbox,
  command: string,
  args: string[],
  timeout = 30_000,
): Promise<string> {
  if (!sandbox.executeCommand) {
    throw new Error(`Sandbox '${sandbox.provider}' cannot run browser commands.`);
  }

  const result = await sandbox.executeCommand(command, args, { timeout });

  if (!result.success) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Sandbox browser command '${command}' failed: ${detail}`);
  }

  return result.stdout;
}

export async function isExecutable(sandbox: WorkspaceSandbox, path: string): Promise<boolean> {
  if (!sandbox.executeCommand) return false;
  const result = await sandbox.executeCommand("test", ["-x", path], { timeout: 5_000 });

  return result.success;
}

export const lightpandaInstalls = new Map<string, Promise<string>>();

export async function installLightpanda(
  sandbox: WorkspaceSandbox,
  cacheDir: string,
): Promise<string> {
  const system = await execute(sandbox, "uname", ["-s"]);
  const machine = await execute(sandbox, "uname", ["-m"]);
  const platform = platformFromUname(system, machine);
  const release = LIGHTPANDA_RELEASES[platform];
  const root = sandbox.provider === "local" ? cacheDir : `/tmp/akeru-browser-${LIGHTPANDA_VERSION}`;
  const binaryPath = NodePath.posix.join(root, "lightpanda");
  const installKey = sandbox.provider === "local" ? binaryPath : `${sandbox.id}:${binaryPath}`;
  const activeInstall = lightpandaInstalls.get(installKey);

  if (activeInstall) return activeInstall;

  const install = (async () => {
    if (await isExecutable(sandbox, binaryPath)) return binaryPath;
    const temporaryPath = `${binaryPath}.download`;
    await execute(sandbox, "mkdir", ["-p", root]);
    await execute(
      sandbox,
      "curl",
      ["-fsSL", "--retry", "2", release.url, "-o", temporaryPath],
      300_000,
    );
    const hashCommand = platform.startsWith("darwin-") ? "shasum" : "sha256sum";

    const hashArgs = platform.startsWith("darwin-")
      ? ["-a", "256", temporaryPath]
      : [temporaryPath];

    const actualHash = (await execute(sandbox, hashCommand, hashArgs)).trim().split(/\s+/)[0];

    if (actualHash !== release.sha256) {
      await sandbox.executeCommand?.("rm", ["-f", temporaryPath], { timeout: 5_000 });
      throw new Error(`Sandbox browser download failed integrity verification for ${platform}.`);
    }

    await execute(sandbox, "chmod", ["700", temporaryPath]);
    await execute(sandbox, "mv", [temporaryPath, binaryPath]);

    return binaryPath;
  })();

  lightpandaInstalls.set(installKey, install);

  try {
    return await install;
  } finally {
    lightpandaInstalls.delete(installKey);
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function lightpandaMcpCommand(binaryPath: string, port: number, host = "0.0.0.0"): string {
  return `${shellQuote(binaryPath)} mcp --host ${shellQuote(host)} --port ${port}`;
}
