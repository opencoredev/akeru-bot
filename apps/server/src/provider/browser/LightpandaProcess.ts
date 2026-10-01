// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import * as NodeNet from "node:net";
import * as NodeTimersPromises from "node:timers/promises";
import type { ProcessHandle, WorkspaceSandbox } from "@mastra/core/workspace";
import { type BrowserRequestTransport } from "./BotBrowserTypes.ts";
import { lightpandaMcpCommand, execute, shellQuote } from "./LightpandaInstall.ts";

export const BROWSER_REQUEST_TIMEOUT_MS = 30_000;

export const REMOTE_BROWSER_PORT = 9_223;

export function availableLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local sandbox browser port."));
        return;
      }
      const port = address.port;
      server.close((cause) => (cause ? reject(cause) : resolve(port)));
    });
  });
}

export function browserRequestTransport(
  url: string,
  requestHeaders: Readonly<Record<string, string>> = {},
): BrowserRequestTransport {
  return async (request) => {
    // This runtime is owned by Mastra's promise-based workspace API, not an Effect layer.
    // @effect-diagnostics-next-line globalFetch:off
    const response = await fetch(url, {
      method: request.method,
      headers: {
        ...requestHeaders,
        accept: "application/json, text/event-stream",
        ...(request.method === "POST" ? { "content-type": "application/json" } : {}),
        ...(request.sessionId ? { "mcp-session-id": request.sessionId } : {}),
      },
      ...(request.body ? { body: request.body } : {}),
      signal: AbortSignal.timeout(BROWSER_REQUEST_TIMEOUT_MS),
    });
    const sessionId = response.headers.get("mcp-session-id");
    return {
      status: response.status,
      body: await response.text(),
      ...(sessionId ? { sessionId } : {}),
    };
  };
}

export type BrowserProcess = Pick<ProcessHandle, "kill"> & {
  readonly wait?: () => Promise<unknown>;
};

export function browserMonitorRetryDelayMs(failures: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(failures - 1, 6));
}

export async function spawnRemoteBrowser(
  sandbox: WorkspaceSandbox,
  binaryPath: string,
  port: number,
): Promise<BrowserProcess> {
  const command = lightpandaMcpCommand(binaryPath, port);
  const output = await execute(sandbox, "sh", [
    "-lc",
    `nohup ${command} >${shellQuote(`/tmp/akeru-browser-${port}.log`)} 2>&1 </dev/null & echo $!`,
  ]);
  const pid = output.trim();
  if (!/^[1-9]\d*$/.test(pid)) {
    throw new Error(`Sandbox '${sandbox.provider}' did not return a browser process id.`);
  }
  let stopped = false;
  // Aborted on kill so a pending retry delay cannot hold the process open.
  const stopSignal = new AbortController();
  const monitorCommand =
    `count=0; while kill -0 ${pid} 2>/dev/null; do ` +
    'count=$((count + 1)); if [ "$count" -ge 20 ]; then printf alive; exit 0; fi; sleep 1; ' +
    "done; printf dead";
  return {
    kill: async () => {
      stopped = true;
      stopSignal.abort();
      return (await sandbox.executeCommand?.("kill", [pid], { timeout: 5_000 }))?.success ?? false;
    },
    wait: async () => {
      let failures = 0;
      while (true) {
        if (stopped) return;
        try {
          const status = (await execute(sandbox, "sh", ["-lc", monitorCommand])).trim();
          failures = 0;
          if (status === "dead") return;
          if (status !== "alive")
            throw new Error("Sandbox browser monitor returned an unknown state.");
        } catch {
          // A command timeout or transport error does not mean the browser exited.
          // Keep watching; only an observed dead process settles this waiter.
          failures += 1;
          if (!stopped) {
            await NodeTimersPromises.setTimeout(browserMonitorRetryDelayMs(failures), undefined, {
              signal: stopSignal.signal,
            }).catch(() => undefined);
          }
        }
      }
    },
  };
}
