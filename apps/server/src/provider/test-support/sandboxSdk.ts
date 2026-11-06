import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import type { RemoteBotSandbox } from "../botWorkspace.ts";
import type { SandboxBinding } from "../workspace/SandboxProviders.ts";
import { workspaceIO } from "./workspaceIO.ts";

const directories: string[] = [];

/** Call from `afterEach`. */
export function removeIdentityFiles() {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
}

export function identityFile() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-sandbox-sdk-"));
  directories.push(directory);

  return NodePath.join(directory, "provider.json");
}

/** A memory sandbox with `echo`, `fail`, `pwd`, and the `printf %s` form Akeru's probes use. */
export function echoProvider() {
  return memory({
    handlers: {
      echo: (context) => {
        context.stdout(`${context.args.join(" ")}\n`);

        return 0;
      },
      fail: (context) => {
        context.stderr("broken\n");

        return 3;
      },
      pwd: (context) => {
        context.stdout(`${context.cwd}\n`);

        return 0;
      },
      printf: (context) => {
        context.stdout(context.args.slice(1).join(""));

        return 0;
      },
    },
  });
}

export function binding(
  provider: Provider,
  overrides: Partial<SandboxBinding> = {},
): SandboxBinding {
  return {
    provider,
    browser: { kind: "none", reason: "This sandbox has no browser." },
    stoppedWake: "fail",
    ...overrides,
  };
}

export function input(
  file: string,
  sandboxBinding: SandboxBinding,
  sandbox: RemoteBotSandbox = "docker",
) {
  return {
    io: workspaceIO,
    threadId: "thread-sdk",
    sandbox,
    workspaceId: "akeru-sdk",
    identityFile: file,
    sandboxBinding,
  };
}

export const saved = (file: string) => JSON.parse(NodeFS.readFileSync(file, "utf8"));

/** Writes an identity the way the pre-migration adapters did: no `workdir` marker. */
export function legacyIdentity(file: string, provider: RemoteBotSandbox, providerId: string) {
  NodeFS.writeFileSync(file, `${JSON.stringify({ provider, providerId })}\n`);
}
