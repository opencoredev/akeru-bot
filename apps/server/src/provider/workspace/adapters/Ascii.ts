import * as Effect from "effect/Effect";
import { type AkeruRemoteSession } from "../BotWorkspaceTypes.ts";
import { quote, commandLine } from "../BotWorkspaceLifecycle.ts";

export function ascii(
  client: import("@asciidev/box-sdk").BoxApi,
  boxId: string,
): AkeruRemoteSession {
  const waitUntilArchived = async () => {
    const deadline = performance.now() + 300_000;

    while (true) {
      const { box } = await client.get({ boxId });

      if (box.state === "archived") return;

      if (box.state === "error") throw new Error("Ascii Box snapshot archival failed.");

      if (performance.now() >= deadline) throw new Error("Ascii Box snapshot archival timed out.");
      await Effect.runPromise(Effect.sleep(2_000));
    }
  };

  return {
    providerId: boxId,
    inspect: async () => {
      try {
        const { box } = await client.get({ boxId });

        if (["ready", "idle", "running"].includes(box.state)) return "running";

        return box.state === "error" ? "missing" : "sleeping";
      } catch (cause) {
        const { ResponseError } = await import("@asciidev/box-sdk");

        if (cause instanceof ResponseError && cause.response.status === 404) return "missing";
        throw cause;
      }
    },
    wake: async () => {
      const { box } = await client.get({ boxId });

      if (box.state === "archiving") await waitUntilArchived();

      if (box.state === "archived" || box.state === "archiving")
        await client.resume({ boxId, resumeRequest: { ttlSeconds: null } });
      const { waitUntilReady } = await import("@asciidev/box-sdk");
      await waitUntilReady(client, boxId, { timeoutMs: 300_000 });
    },
    // Stop takes a native lifecycle snapshot; never force-stop and discard VM changes.
    sleep: async () => {
      await client.stop({ boxId });
      await waitUntilArchived();
    },
    destroy: async () => {
      let result = await client.deleteBox({ boxId, xAsciiConfirmDelete: boxId });
      const deadline = performance.now() + 300_000;

      while (result.operation.status !== "completed") {
        if (result.operation.status === "blocked")
          throw new Error("Ascii Box deletion is blocked.");

        if (performance.now() >= deadline) throw new Error("Ascii Box deletion timed out.");
        await Effect.runPromise(Effect.sleep(2_000));
        result = await client.getDeletionOperation({ operationId: result.operation.id });
      }
    },
    run: async (command, args, options) => {
      const timeout = options?.timeout ?? 600_000;

      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600_000)
        throw new Error("Ascii Box command timeout must be greater than 0 and at most 600000 ms.");

      const env = Object.entries(options?.env ?? {}).map(([key, value]) =>
        quote(`${key}=${value}`),
      );

      const invocation = `${env.length ? `env ${env.join(" ")} ` : ""}${commandLine(command, args)}`;

      const result = await client.command({
        boxId,
        commandRequest: {
          command: options?.cwd ? `cd ${quote(options.cwd)} && ${invocation}` : invocation,
          timeoutSeconds: Math.ceil(timeout / 1_000),
        },
      });

      if (result.type !== "command.finished")
        throw new Error("Ascii Box command did not finish in the foreground.");

      return {
        exitCode: result.timedOut ? 124 : (result.exitCode ?? (result.success ? 0 : 1)),
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    browserEndpoint: async (port) => {
      const result = await client.hostPort({ boxId, hostPortRequest: { port, _public: false } });

      if (!result.url || result.success === false)
        throw new Error("Ascii Box workspace did not return a preview URL.");

      if (result.isProtected !== true || !new URL(result.url).searchParams.get("_token"))
        throw new Error("Ascii Box workspace did not return a protected browser endpoint.");

      return { url: result.url, requestHeaders: {} };
    },
  };
}
