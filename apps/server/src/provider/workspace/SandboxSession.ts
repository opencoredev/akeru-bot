import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Path from "effect/Path";
import { hasCapability, SandboxError, type SandboxBase } from "@opencoredev/sandbox-sdk";
import { DaytonaComputer } from "../daytonaComputer.ts";
import { WorkspaceComputer } from "../workspaceComputer.ts";
import { commandLine, quote } from "./BotWorkspaceLifecycle.ts";
import type {
  AkeruBrowserEndpoint,
  AkeruRemoteSession,
  AkeruWorkspaceState,
} from "./BotWorkspaceTypes.ts";
import { withAdoption, type AdoptionEffects } from "./SandboxAdoption.ts";
import { header, type SandboxBinding } from "./SandboxProviders.ts";

const posixPath = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));

/** Commands without their own timeout keep the ten-minute bound the old adapters used. */
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

/** Workspace file reads go through `files`, so command output stays small; this is a safety bound. */
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;

const DESKTOP_BROWSER_PORT = 9222;

/** The sandbox's state, reading SDK metadata through adoption so missing metadata is not absence. */
export async function inspectSandbox(
  box: SandboxBase<unknown>,
  binding: SandboxBinding,
): Promise<AkeruWorkspaceState> {
  if (binding.peek) {
    return Match.value(await binding.peek(box.id)).pipe(
      Match.when("missing", () => "missing" as const),
      Match.when("running", () => "running" as const),
      Match.orElse(() => "sleeping" as const),
    );
  }

  try {
    const { state } = await withAdoption(binding.adopt, box.id, () =>
      binding.provider.connect(box.id),
    );

    return state === "running" ? "running" : "sleeping";
  } catch (cause) {
    if (cause instanceof SandboxError && cause.code === "not_found") return "missing";
    throw cause;
  }
}

/**
 * Brings the sandbox up the way the provider allows. `effects.resumed` is set before the
 * sandbox is started, so a wake that starts it and then fails still gets it paused again.
 */
export async function wakeSandbox(
  box: SandboxBase<unknown>,
  binding: SandboxBinding,
  effects: AdoptionEffects = { resumed: false },
) {
  const state = await inspectSandbox(box, binding);

  if (state === "missing") throw new Error(`${box.provider} workspace '${box.id}' is missing.`);

  if (state === "running") return;

  if (hasCapability(box, "pause")) {
    effects.resumed = true;
    await box.resume();

    return;
  }

  if (binding.stoppedWake === "on-use") return;

  if (binding.stoppedWake === "fail")
    throw new Error(`${box.provider} workspace '${box.id}' is not running.`);
  effects.resumed = true;
  await binding.stoppedWake(box.id);
}

const SHELL_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** One `AkeruRemoteSession` for every provider, backed by a sandbox-sdk handle. */
export async function sandboxSession(
  box: SandboxBase<unknown>,
  binding: SandboxBinding,
  workdir: string,
  user?: string,
): Promise<AkeruRemoteSession> {
  const canPause = hasCapability(box, "pause");
  const inspect = () => inspectSandbox(box, binding);

  const run: AkeruRemoteSession["run"] = async (command, args, options) => {
    const line = commandLine(command, args);
    const cwd = posixPath.resolve(workdir, options?.cwd ?? ".");

    // Some images reset the directory or environment under `su`, so the script sets both itself.
    const asUser = (name: string) => {
      const exports = Object.entries(options?.env ?? {}).map(([variable, value]) => {
        if (!SHELL_VARIABLE_NAME.test(variable))
          throw new Error(`Environment variable name '${variable}' is not valid.`);

        return `export ${variable}=${quote(value)};`;
      });

      return commandLine("su", [
        "-s",
        "/bin/sh",
        "-c",
        // `|| exit` stops the whole script, so no export or command runs in the wrong directory.
        [`cd ${quote(cwd)} || exit;`, ...exports, line].join(" "),
        name,
      ]);
    };

    const result = await box.run(user ? asUser(user) : line, {
      cwd,
      ...(options?.env ? { env: options.env } : {}),
      timeoutMs: options?.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    });

    if (result.truncated)
      throw new Error(`Command output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes.`);

    // A killed command has no exit code; never report it as success.
    return {
      exitCode: result.exitCode ?? (result.timedOut ? 124 : 1),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };

  const preview = async (port: number): Promise<AkeruBrowserEndpoint> => {
    const ingress = binding.browser;

    if (ingress.kind === "none") throw new Error(ingress.reason);
    await binding.routePort?.(box.id, port);
    const value = await box.preview(port);

    if (binding.browserEndpoint) return binding.browserEndpoint(value);

    const requestHeaders = Object.fromEntries(
      Object.entries(value.headers ?? {}).map(([key, entry]) => [key.toLowerCase(), entry]),
    );

    if (
      ingress.kind === "private" &&
      Object.keys(requestHeaders).length === 0 &&
      new URL(value.url).search === ""
    )
      throw new Error(
        `${box.provider} workspace '${box.id}' has no authenticated browser endpoint.`,
      );

    return {
      url: value.url,
      requestHeaders,
      ...(ingress.kind === "loopback" && { loopback: true }),
    };
  };

  const computer = binding.desktop
    ? new WorkspaceComputer(
        box.id,
        new DaytonaComputer(await binding.desktop(box.id)),
        // Chromium survives reconnects and some wakes; reuse it instead of starting
        // a second browser on the same profile and debugging port.
        async () => {
          const result = await run(
            "sh",
            [
              "-c",
              `command -v chromium >/dev/null || command -v chromium-browser >/dev/null || exit 1; profile=/tmp/akeru-chromium; command -v pgrep >/dev/null && pgrep -f "[-]-user-data-dir=$profile" >/dev/null && exit 0; mkdir -p $profile; nohup \${CHROMIUM_BIN:-$(command -v chromium || command -v chromium-browser)} --no-sandbox --disable-dev-shm-usage --remote-debugging-address=0.0.0.0 --remote-debugging-port=${DESKTOP_BROWSER_PORT} --user-data-dir=$profile about:blank >/dev/null 2>&1 </dev/null &`,
            ],
            { env: { DISPLAY: ":1" } },
          );

          if (result.exitCode !== 0) throw new Error("Graphical Chromium is unavailable.");
        },
        async () => {
          const value = await box.preview(DESKTOP_BROWSER_PORT);
          const token = header(value, "x-daytona-preview-token");

          if (!token) throw new Error("Desktop browser endpoint is unavailable.");

          return { url: value.url, requestHeaders: { "x-daytona-preview-token": token } };
        },
        inspect,
      )
    : undefined;

  return {
    providerId: box.id,
    capabilities: {
      pause: canPause,
      snapshot: hasCapability(box, "snapshot"),
      browser: binding.browser.kind !== "none",
      reconnect: true,
    },
    ...(computer ? { computer } : {}),
    files: box.files,
    workdir,
    ...(user ? { user } : {}),
    inspect,
    run,
    browserEndpoint: preview,
    wake: async () => {
      await wakeSandbox(box, binding);
    },
    // Without pause, idle keeps the durable sandbox and its identity (Railway, Daytona, Boat).
    sleep: async () => {
      if (hasCapability(box, "pause")) await box.pause();
    },
    destroy: () => box.destroy(),
  };
}
