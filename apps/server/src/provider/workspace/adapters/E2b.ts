// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { type AkeruRemoteSession } from "../BotWorkspaceTypes.ts";
import { commandLine } from "../BotWorkspaceLifecycle.ts";

export function e2b(initial: import("e2b").Sandbox, apiKey?: string): AkeruRemoteSession {
  let sandbox = initial;
  const providerId = sandbox.sandboxId;
  const options = apiKey ? { apiKey } : {};

  return {
    providerId,
    inspect: async () => {
      const { Sandbox } = await import("e2b");
      const info = await Sandbox.getInfo(providerId, options);

      return info.state === "paused" ? "sleeping" : "running";
    },
    run: async (command, args, options) => {
      const result = await sandbox.commands.run(commandLine(command, args), {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { envs: options.env } : {}),
        ...(options?.timeout ? { timeoutMs: options.timeout } : {}),
      });

      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    browserEndpoint: async (port) => {
      const token = sandbox.trafficAccessToken?.trim();

      if (!token) throw new Error(`E2B workspace '${providerId}' has no traffic access token.`);

      return {
        url: `https://${sandbox.getHost(port)}`,
        requestHeaders: { "e2b-traffic-access-token": token },
      };
    },
    wake: async () => {
      const { Sandbox } = await import("e2b");
      sandbox = await Sandbox.connect(providerId, options);
    },
    sleep: async () => {
      await sandbox.pause();
    },
    destroy: async () => {
      await sandbox.kill();
    },
  };
}
