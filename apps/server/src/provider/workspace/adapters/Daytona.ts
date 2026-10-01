// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { DaytonaComputer } from "../../daytonaComputer.ts";
import { WorkspaceComputer } from "../../workspaceComputer.ts";
import { type AkeruRemoteSession, type AkeruWorkspaceState } from "../BotWorkspaceTypes.ts";
import { commandLine } from "../BotWorkspaceLifecycle.ts";

export function daytona(
  client: import("@daytona/sdk").Daytona,
  sandbox: import("@daytona/sdk").Sandbox,
): AkeruRemoteSession {
  const inspect = async (): Promise<AkeruWorkspaceState> => {
    await sandbox.refreshData();
    const current = String(sandbox.state);
    return current === "destroyed" ? "missing" : current === "started" ? "running" : "sleeping";
  };
  const computer = new WorkspaceComputer(
    sandbox.id,
    new DaytonaComputer(sandbox),
    // Chromium survives reconnects and some wakes; reuse it instead of starting
    // a second browser on the same profile and debugging port.
    async () => {
      const result = await sandbox.process.executeCommand(
        "sh -c 'command -v chromium >/dev/null || command -v chromium-browser >/dev/null || exit 1; profile=/tmp/akeru-chromium; command -v pgrep >/dev/null && pgrep -f \"[-]-user-data-dir=$profile\" >/dev/null && exit 0; mkdir -p $profile; nohup ${CHROMIUM_BIN:-$(command -v chromium || command -v chromium-browser)} --no-sandbox --disable-dev-shm-usage --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 --user-data-dir=$profile about:blank >/dev/null 2>&1 </dev/null &'",
        undefined,
        { DISPLAY: ":1" },
      );
      if (result.exitCode !== 0) throw new Error("Daytona graphical Chromium is unavailable.");
    },
    async () => {
      const preview = await sandbox.getPreviewLink(9222);
      if (!preview.url || !preview.token)
        throw new Error("Daytona browser endpoint is unavailable.");
      return { url: preview.url, requestHeaders: { "x-daytona-preview-token": preview.token } };
    },
    inspect,
  );
  return {
    providerId: sandbox.id,
    computer,
    inspect,
    run: async (command, args, options) => {
      const result = await sandbox.process.executeCommand(
        commandLine(command, args),
        options?.cwd,
        options?.env,
        options?.timeout ? Math.ceil(options.timeout / 1000) : undefined,
      );
      return { exitCode: result.exitCode, stdout: result.result, stderr: "" };
    },
    browserEndpoint: async (port) => {
      const preview = await sandbox.getPreviewLink(port);
      const token = preview.token?.trim();
      if (!preview.url || !token) {
        throw new Error(`Daytona workspace '${sandbox.id}' has no authenticated preview URL.`);
      }
      const url = new URL(preview.url);
      url.searchParams.set("DAYTONA_SANDBOX_AUTH_KEY", token);
      return { url: url.toString(), requestHeaders: {} };
    },
    wake: async () => {
      if ((await sandbox.refreshData(), String(sandbox.state)) !== "started") {
        await sandbox.start();
      }
    },
    sleep: () => sandbox.pause(),
    destroy: async () => {
      await sandbox.delete(undefined, true);
      await client[Symbol.asyncDispose]();
    },
  };
}
