// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { credential, commandLine } from "../BotWorkspaceLifecycle.ts";
import { type AkeruRemoteSession, type AkeruWorkspaceState } from "../BotWorkspaceTypes.ts";

export function railwayCredentials(environment: Readonly<Record<string, string>>) {
  return {
    token: credential(environment, "RAILWAY_API_TOKEN"),
    environmentId: credential(environment, "RAILWAY_ENVIRONMENT_ID"),
  };
}

export function railway(sandbox: import("railway").Sandbox): AkeruRemoteSession {
  const inspect = async (): Promise<AkeruWorkspaceState> => {
    const { SandboxNotFoundError } = await import("railway");
    try {
      await sandbox.refresh();
    } catch (cause) {
      if (cause instanceof SandboxNotFoundError) return "missing";
      throw cause;
    }
    return railwayWorkspaceState(sandbox.status);
  };
  return {
    providerId: sandbox.id,
    inspect,
    run: async (command, args, options) => {
      const result = await sandbox.exec(commandLine(command, args), {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: options.env } : {}),
        ...(options?.timeout ? { timeoutSec: Math.ceil(options.timeout / 1000) } : {}),
      });
      return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    browserEndpoint: async () => {
      throw new Error(
        "Railway previews require a Railway CLI tunnel. Automatic bot browser routing is not supported; private VM addresses are not browser endpoints.",
      );
    },
    wake: async () => {
      if ((await inspect()) !== "running")
        throw new Error(`Railway workspace '${sandbox.id}' is not running.`);
    },
    // Railway has no pause/resume API; idle preserves the durable VM and its identity.
    sleep: async () => undefined,
    destroy: () => sandbox.destroy(),
  };
}

export function railwayWorkspaceState(
  status: import("railway").SandboxStatus,
): AkeruWorkspaceState {
  if (status === "RUNNING") return "running";
  if (status === "CREATING") return "sleeping";
  return "missing";
}
