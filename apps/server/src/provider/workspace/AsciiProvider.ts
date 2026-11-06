import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { SandboxError, type ErrorCode } from "@opencoredev/sandbox-sdk";
import type { ExecInput, Provider, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import { quote } from "./BotWorkspaceLifecycle.ts";
import { shellFiles, type ScriptResult } from "./ShellFiles.ts";

type BoxApi = import("@asciidev/box-sdk").BoxApi;

const LIFECYCLE_TIMEOUT_MS = 300_000;

const MAX_COMMAND_TIMEOUT_MS = 600_000;

const RUNNING_STATES = new Set(["ready", "idle", "running"]);

const failure = (message: string, code: ErrorCode, sandboxId?: string) =>
  new SandboxError(message, {
    code,
    provider: "ascii",
    ...(sandboxId ? { sandboxId } : {}),
  });

/**
 * Ascii Box is not a sandbox-sdk provider, so this shim implements the SDK's custom
 * provider contract over `@asciidev/box-sdk`. Files travel through base64 commands.
 */
export async function asciiProvider(apiKey: string): Promise<Provider<BoxApi, "pause">> {
  const sdk = await import("@asciidev/box-sdk");
  const client = new sdk.BoxApi(new sdk.Configuration({ accessToken: apiKey }));

  const mapped = async <A>(id: string | undefined, action: () => Promise<A>): Promise<A> => {
    try {
      return await action();
    } catch (cause) {
      if (cause instanceof SandboxError) throw cause;

      if (cause instanceof sdk.ResponseError) {
        const status = cause.response.status;

        throw failure(
          `Ascii Box request failed with HTTP ${status}.`,
          status === 404
            ? "not_found"
            : status === 401 || status === 403
              ? "auth"
              : status === 429
                ? "quota"
                : "provider",
          id,
        );
      }

      throw failure(cause instanceof Error ? cause.message : String(cause), "provider", id);
    }
  };

  const poll = async (description: string, done: () => Promise<boolean>) => {
    const deadline = performance.now() + LIFECYCLE_TIMEOUT_MS;

    while (!(await done())) {
      if (performance.now() >= deadline)
        throw failure(`Ascii Box ${description} timed out.`, "timeout");
      await Effect.runPromise(Effect.sleep(2_000));
    }
  };

  const waitUntilArchived = (boxId: string) =>
    poll("snapshot archival", async () => {
      const { box } = await client.get({ boxId });

      if (box.state === "error")
        throw failure("Ascii Box snapshot archival failed.", "provider", boxId);

      return box.state === "archived";
    });

  const info = (id: string, state: string): SandboxInfo => ({
    id,
    labels: {},
    createdAt: Effect.runSync(Clock.currentTimeMillis),
    state: RUNNING_STATES.has(state)
      ? "running"
      : state === "archived" || state === "archiving"
        ? "paused"
        : "stopped",
  });

  async function exec(boxId: string, input: ExecInput) {
    if (input.stdin !== undefined)
      throw failure("Ascii Box commands cannot take stdin.", "unsupported", boxId);

    // Longer timeouts are refused before the command starts rather than silently shortened.
    if (!(input.timeoutMs > 0 && input.timeoutMs <= MAX_COMMAND_TIMEOUT_MS))
      throw failure(
        "Ascii Box command timeout must be greater than 0 and at most 600000 ms.",
        "invalid_argument",
        boxId,
      );
    const timeout = input.timeoutMs;
    const env = Object.entries(input.env).map(([key, value]) => quote(`${key}=${value}`));

    const result = await client.command({
      boxId,
      commandRequest: {
        // The SDK's default working directory is /workspace, which Ascii images do not ship.
        command: `mkdir -p /workspace 2>/dev/null; cd ${quote(input.cwd)} && ${env.length ? `env ${env.join(" ")} ` : ""}sh -c ${quote(input.command)}`,
        timeoutSeconds: Math.max(1, Math.ceil(timeout / 1_000)),
      },
    });

    if (result.type !== "command.finished")
      throw failure("Ascii Box command did not finish in the foreground.", "provider", boxId);

    if (result.stdout) input.onChunk({ stream: "stdout", text: result.stdout });

    if (result.stderr) input.onChunk({ stream: "stderr", text: result.stderr });

    return {
      exitCode: result.timedOut ? null : (result.exitCode ?? (result.success ? 0 : 1)),
      timedOut: result.timedOut === true,
    };
  }

  /** Runs one file script with its output collected, for the shared shell file primitives. */
  async function script(boxId: string, command: string): Promise<ScriptResult> {
    let stdout = "";
    let stderr = "";

    const result = await exec(boxId, {
      command,
      cwd: "/",
      env: {},
      timeoutMs: MAX_COMMAND_TIMEOUT_MS,
      onChunk: (chunk) => {
        if (chunk.stream === "stdout") stdout += chunk.text;
        else stderr += chunk.text;
      },
    });

    return { exitCode: result.exitCode, stdout, stderr };
  }

  return {
    name: "ascii",
    keyMode: "best-effort",
    capabilities: new Set(["pause"]),
    create: (input) =>
      mapped(undefined, async () => {
        if (
          input.size !== undefined ||
          input.from !== undefined ||
          input.timeoutMs !== undefined ||
          input.idleTimeoutMs !== undefined ||
          (input.network !== undefined && input.network !== "all") ||
          Object.keys(input.env ?? {}).length > 0
        )
          throw failure("Ascii Box cannot enforce these creation options.", "unsupported");

        const { box } = await client.create({
          createBoxRequest: { ttlSeconds: null, noEnv: true },
        });

        return info(box.id, "running");
      }),
    find: async () => undefined,
    list: async () => [],
    connect: (id) =>
      mapped(id, async () => {
        const { box } = await client.get({ boxId: id });

        return info(id, box.state);
      }),
    destroy: (id) =>
      mapped(id, async () => {
        let result = await client.deleteBox({ boxId: id, xAsciiConfirmDelete: id });

        await poll("deletion", async () => {
          if (result.operation.status === "completed") return true;

          if (result.operation.status === "blocked")
            throw failure("Ascii Box deletion is blocked.", "provider", id);
          result = await client.getDeletionOperation({ operationId: result.operation.id });

          return result.operation.status === "completed";
        });
      }),
    exec: (id, input) => mapped(id, () => exec(id, input)),
    files: shellFiles("ascii", (id, command) => mapped(id, () => script(id, command))),
    previewUrl: (id, port) =>
      mapped(id, async () => {
        const result = await client.hostPort({
          boxId: id,
          hostPortRequest: { port, _public: false },
        });

        if (!result.url || result.success === false)
          throw failure("Ascii Box workspace did not return a preview URL.", "provider", id);

        if (result.isProtected !== true || !new URL(result.url).searchParams.get("_token"))
          throw failure(
            "Ascii Box workspace did not return a protected preview URL.",
            "provider",
            id,
          );

        return { url: result.url };
      }),
    native: () => client,
    // Stop takes a native lifecycle snapshot; never force-stop and discard VM changes.
    pause: (id) =>
      mapped(id, async () => {
        await client.stop({ boxId: id });
        await waitUntilArchived(id);
      }),
    resume: (id) =>
      mapped(id, async () => {
        const { box } = await client.get({ boxId: id });

        if (box.state === "archiving") await waitUntilArchived(id);

        if (box.state === "archived" || box.state === "archiving")
          await client.resume({ boxId: id, resumeRequest: { ttlSeconds: null } });
        await sdk.waitUntilReady(client, id, { timeoutMs: LIFECYCLE_TIMEOUT_MS });
      }),
  };
}
