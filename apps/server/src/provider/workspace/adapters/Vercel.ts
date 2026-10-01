// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { type AkeruWorkspaceState, type AkeruRemoteSession } from "../BotWorkspaceTypes.ts";
import { credential } from "../BotWorkspaceLifecycle.ts";

export function vercelWorkspaceState(
  status: import("@vercel/sandbox").Sandbox["status"],
): AkeruWorkspaceState {
  if (status === "running") return "running";

  if (status === "failed" || status === "aborted") return "missing";

  return "sleeping";
}

export function vercel(
  initial: import("@vercel/sandbox").Sandbox,
  environment: Readonly<Record<string, string>> = {},
): AkeruRemoteSession {
  let sandbox = initial;

  return {
    providerId: sandbox.name,
    inspect: async () => {
      const { Sandbox } = await import("@vercel/sandbox");
      sandbox = await Sandbox.get({
        name: sandbox.name,
        resume: false,
        token: credential(environment, "VERCEL_TOKEN"),
        teamId: credential(environment, "VERCEL_TEAM_ID"),
        projectId: credential(environment, "VERCEL_PROJECT_ID"),
      });

      return vercelWorkspaceState(sandbox.status);
    },
    run: async (command, args, options) => {
      const result = await sandbox.runCommand({
        cmd: command,
        args: [...args],
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: options.env } : {}),
        ...(options?.timeout ? { timeoutMs: options.timeout } : {}),
      });

      return {
        exitCode: result.exitCode,
        stdout: await result.stdout(),
        stderr: await result.stderr(),
      };
    },
    browserEndpoint: async (port) => {
      if (!sandbox.routes.some((route) => route.port === port)) {
        await sandbox.update({ ports: [...sandbox.routes.map((route) => route.port), port] });
      }

      return { url: sandbox.domain(port), requestHeaders: {} };
    },
    wake: async () => {
      const { Sandbox } = await import("@vercel/sandbox");
      sandbox = await Sandbox.get({
        name: sandbox.name,
        resume: true,
        token: credential(environment, "VERCEL_TOKEN"),
        teamId: credential(environment, "VERCEL_TEAM_ID"),
        projectId: credential(environment, "VERCEL_PROJECT_ID"),
      });
    },
    sleep: async () => {
      await sandbox.stop();
    },
    destroy: async () => {
      await sandbox.delete();
    },
  };
}
