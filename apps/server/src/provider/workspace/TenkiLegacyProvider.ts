import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { SandboxError, type ErrorCode } from "@opencoredev/sandbox-sdk";
import type { ExecInput, Provider, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import { shellFiles, type ScriptResult } from "./ShellFiles.ts";

type Session = import("@tenkicloud/sandbox").Session;

const TERMINAL_STATES = new Set(["TERMINATED", "TERMINATING"]);

const PAUSED_STATES = new Set(["PAUSED", "PAUSING", "RESUMING", "USER_SHUTDOWN"]);

const failure = (message: string, code: ErrorCode, sandboxId?: string) =>
  new SandboxError(message, {
    code,
    provider: "tenki",
    ...(sandboxId ? { sandboxId } : {}),
  });

/**
 * Tenki sessions made by Akeru's earlier adapter carry none of the session metadata Sandbox
 * SDK's `tenki()` requires, and Tenki cannot add metadata to an existing session, so the SDK
 * refuses them. This shim drives those sessions the way the old adapter did, through
 * `@tenkicloud/sandbox`, behind the SDK's provider contract. It only reattaches; new Tenki
 * workspaces use the SDK.
 */
export async function tenkiLegacyProvider(apiKey: string): Promise<Provider<Session, "pause">> {
  const sdk = await import("@tenkicloud/sandbox");
  const client = new sdk.TenkiSandbox({ apiKey });
  const sessions = new Map<string, Session>();

  const mapped = async <A>(id: string | undefined, action: () => Promise<A>): Promise<A> => {
    try {
      return await action();
    } catch (cause) {
      if (cause instanceof SandboxError) throw cause;

      if (cause instanceof sdk.SessionNotFoundError || cause instanceof sdk.SessionTerminatedError)
        throw failure(`Tenki session ${id ?? ""} was not found.`, "not_found", id);

      if (cause instanceof sdk.UnauthorizedError || cause instanceof sdk.PermissionDeniedError)
        throw failure("Tenki rejected the API key.", "auth", id);

      throw failure(cause instanceof Error ? cause.message : String(cause), "provider", id);
    }
  };

  async function session(id: string) {
    const cached = sessions.get(id);

    if (cached) return cached;
    const value = await client.get(id);
    sessions.set(id, value);

    return value;
  }

  const info = (value: Session): SandboxInfo => ({
    id: value.id,
    labels: {},
    createdAt: Effect.runSync(Clock.currentTimeMillis),
    state:
      value.state === "RUNNING" ? "running" : PAUSED_STATES.has(value.state) ? "paused" : "stopped",
  });

  async function exec(id: string, input: ExecInput) {
    if (input.stdin !== undefined)
      throw failure("Legacy Tenki commands cannot take stdin.", "unsupported", id);

    const result = await (
      await session(id)
    ).exec(["sh", "-c", input.command], {
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
    });

    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);

    if (stdout) input.onChunk({ stream: "stdout", text: stdout });

    if (stderr) input.onChunk({ stream: "stderr", text: stderr });
    const timedOut = result.status === "TIMED_OUT";

    return { exitCode: timedOut ? null : result.exitCode, timedOut };
  }

  async function script(id: string, command: string): Promise<ScriptResult> {
    let stdout = "";
    let stderr = "";

    const result = await exec(id, {
      command,
      cwd: "/",
      env: {},
      timeoutMs: 600_000,
      onChunk: (chunk) => {
        if (chunk.stream === "stdout") stdout += chunk.text;
        else stderr += chunk.text;
      },
    });

    return { exitCode: result.exitCode, stdout, stderr };
  }

  return {
    name: "tenki",
    keyMode: "best-effort",
    capabilities: new Set(["pause"]),
    create: async () => {
      throw failure("Legacy Tenki sessions can only be reattached.", "unsupported");
    },
    find: async () => undefined,
    list: async () => [],
    connect: (id) =>
      mapped(id, async () => {
        sessions.delete(id);
        const value = await session(id);
        await value.refresh();

        if (TERMINAL_STATES.has(value.state))
          throw failure(`Tenki session ${id} has terminated.`, "not_found", id);

        return info(value);
      }),
    destroy: (id) =>
      mapped(id, async () => {
        try {
          await (await session(id)).close();
        } finally {
          sessions.delete(id);
        }
      }),
    exec: (id, input) => mapped(id, () => exec(id, input)),
    files: shellFiles("tenki", (id, command) => mapped(id, () => script(id, command))),
    previewUrl: async (id) => {
      throw failure("Legacy Tenki sessions serve no authenticated previews.", "unsupported", id);
    },
    native: (id) => {
      const value = sessions.get(id);

      if (!value) throw failure(`Tenki session ${id} is not attached.`, "not_found", id);

      return value;
    },
    pause: (id) =>
      mapped(id, async () => {
        const value = await session(id);
        await value.pause();
        await value.waitPaused();
      }),
    // The old adapter's wake: wait out a pause in progress, then resume or wait for readiness.
    resume: (id) =>
      mapped(id, async () => {
        const value = await session(id);
        await value.refresh();

        if (value.state === "PAUSING") await value.waitPaused();

        if (value.state === "PAUSED" || value.state === "USER_SHUTDOWN") {
          await value.resume();
          await value.waitResumed();
        } else if (value.state === "RESUMING") {
          await value.waitResumed();
        } else {
          await value.waitReady();
        }
      }),
  };
}
