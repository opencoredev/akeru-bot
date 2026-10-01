// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { type AkeruRemoteSession, type AkeruWorkspaceState } from "../BotWorkspaceTypes.ts";

export function tenki(session: import("@tenkicloud/sandbox").Session): AkeruRemoteSession {
  return {
    providerId: session.id,
    inspect: async () => {
      await session.refresh();
      return tenkiWorkspaceState(session.state);
    },
    run: async (command, args, options) => {
      const result = await session.exec([command, ...args], {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: options.env } : {}),
        ...(options?.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
      });
      return {
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
        exitCode: result.exitCode,
      };
    },
    browserEndpoint: async () => {
      // Public application previews must not expose the browser's unauthenticated MCP server.
      throw new Error(
        "Tenki sandbox browser requires an authenticated endpoint; public previews are not supported for browser control.",
      );
    },
    wake: async () => {
      await session.refresh();
      if (session.state === "PAUSING") await session.waitPaused();
      if (session.state === "PAUSED" || session.state === "USER_SHUTDOWN") {
        await session.resume();
        await session.waitResumed();
      } else if (session.state === "RESUMING") {
        await session.waitResumed();
      } else {
        await session.waitReady();
      }
    },
    sleep: async () => {
      await session.pause();
      await session.waitPaused();
    },
    destroy: () => session.close(),
  };
}

export function tenkiWorkspaceState(
  state: import("@tenkicloud/sandbox").SessionState,
): AkeruWorkspaceState {
  switch (state) {
    case "RUNNING":
      return "running";
    case "CREATING":
    case "PAUSED":
    case "USER_SHUTDOWN":
    case "PAUSING":
    case "RESUMING":
      return "sleeping";
    default:
      return "missing";
  }
}
