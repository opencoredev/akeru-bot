import * as Effect from "effect/Effect";
import type { BotSandbox } from "@akeru/contracts";
import * as Predicate from "effect/Predicate";
import { SandboxError, type Preview } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { REMOTE_BROWSER_PORT } from "../browser/LightpandaProcess.ts";
import { credential } from "./BotWorkspaceLifecycle.ts";
import { oneAtATime } from "./oneAtATime.ts";
import type { AkeruBrowserEndpoint, RemoteBotSandbox } from "./BotWorkspaceTypes.ts";
import { railwayAdoption, upstashAdoption, type SandboxAdoption } from "./SandboxAdoption.ts";

/**
 * How a provider's preview URL may serve as a bot browser endpoint.
 * `private` previews must carry access headers or a URL token; `none` refuses browser control.
 */
export type BrowserIngress =
  | { readonly kind: "private" | "public" | "loopback" }
  | { readonly kind: "none"; readonly reason: string };

/** A configured sandbox-sdk provider plus the few Akeru rules the SDK cannot express. */
export interface SandboxBinding {
  readonly provider: Provider;
  readonly browser: BrowserIngress;
  /**
   * What wake does when a provider without the `pause` capability reports a stopped sandbox:
   * `start` it natively, trust the provider to wake it `on-use`, or `fail` closed (Railway).
   */
  readonly stoppedWake: "on-use" | "fail" | ((id: string) => Promise<void>);
  /** Ports to publish at creation, for providers that only route declared ports. */
  readonly ports?: readonly number[];
  readonly browserEndpoint?: (preview: Preview) => AkeruBrowserEndpoint;
  readonly desktop?: (id: string) => Promise<import("@daytona/sdk").Sandbox>;
  /**
   * The directory a pre-migration adapter ran commands in, read through the provider's own
   * SDK with no working directory set. Without it, Akeru uses the sandbox user's `$HOME`.
   */
  readonly legacyWorkdir?: (id: string) => Promise<string>;
  /**
   * The user a pre-migration adapter ran commands as, where the SDK runs as a different one.
   * Legacy sandboxes keep running as it, so files keep their owner. Its home is the workdir.
   */
  readonly legacyUser?: string;
  /**
   * Makes the provider route `port` before a preview is requested, for providers that only
   * route ports declared at creation. Sandboxes made by the old adapters declared none.
   */
  readonly routePort?: (id: string, port: number) => Promise<void>;
  /** Writes missing SDK metadata on a sandbox an old adapter made; see `SandboxAdoption`. */
  readonly adopt?: SandboxAdoption;
  /**
   * Reads the sandbox's state without touching it, for providers whose SDK `connect` wakes a
   * paused sandbox (E2B resumes on connect; Upstash runs a command, which resumes the box).
   * `inspect` uses it instead of `connect`, and reattach reads it before connecting so a
   * failed reattach can pause what the connect woke.
   */
  readonly peek?: (id: string) => Promise<SandboxPeek>;
  /**
   * A binding over a shim provider for sandboxes the SDK refuses because the old adapter left
   * metadata the SDK needs, and the provider cannot add it later (Tenki). Reattach only.
   */
  readonly legacy?: () => Promise<SandboxBinding>;
}

/** A sandbox's state as the provider reports it, read without side effects. */
export type SandboxPeek = "running" | "paused" | "stopped" | "missing";

type Environment = Readonly<Record<string, string>>;

const BINDINGS: Record<RemoteBotSandbox, (environment: Environment) => Promise<SandboxBinding>> = {
  e2b: async (environment) => {
    const { e2b } = await import("@opencoredev/sandbox-sdk/e2b");

    const provider = e2b({
      apiKey: credential(environment, "E2B_API_KEY"),
      public: false,
      autoPause: true,
    });

    return {
      provider,
      // The old adapter used E2B's default `user`; the SDK runs everything as root.
      legacyUser: "user",
      peek: async (id) => {
        try {
          const details = await provider.api.request("GET", `/sandboxes/${encodeURIComponent(id)}`);

          // E2B has two states, `running` and `paused`; a killed sandbox answers 404.
          return Predicate.hasProperty(details, "state") && details.state === "paused"
            ? "paused"
            : "running";
        } catch (cause) {
          if (cause instanceof SandboxError && cause.code === "not_found") return "missing";
          throw cause;
        }
      },
      browser: { kind: "private" },
      stoppedWake: "fail",
    };
  },
  daytona: async (environment) => {
    const { daytona } = await import("@opencoredev/sandbox-sdk/daytona");
    const provider = daytona({ apiKey: credential(environment, "DAYTONA_API_KEY"), public: false });

    return {
      provider,
      // The old adapter ran commands with no cwd: Daytona's work dir (Dockerfile WORKDIR, else home).
      legacyWorkdir: async (id) => {
        const client = await provider.api.sdk(() => import("@daytona/sdk"));

        return (await (await client.get(id)).getWorkDir()) ?? "";
      },
      browser: { kind: "private" },
      // The SDK has no Daytona pause; Daytona stops idle sandboxes itself, so wake starts them.
      stoppedWake: async (id) => {
        await provider.api.request("POST", `/sandbox/${encodeURIComponent(id)}/start`);
        await waitUntilRunning(provider, id);
      },
      browserEndpoint: (preview) => {
        const token = header(preview, "x-daytona-preview-token");

        if (!token) throw new Error("Daytona workspace has no authenticated preview URL.");
        const url = new URL(preview.url);
        url.searchParams.set("DAYTONA_SANDBOX_AUTH_KEY", token);

        return { url: url.toString(), requestHeaders: {} };
      },
      desktop: async (id) => {
        const client = await provider.api.sdk(() => import("@daytona/sdk"));

        return client.get(id);
      },
    };
  },
  vercel: async (environment) => {
    const { vercel } = await import("@opencoredev/sandbox-sdk/vercel");

    const credentials = {
      token: credential(environment, "VERCEL_TOKEN"),
      teamId: credential(environment, "VERCEL_TEAM_ID"),
      projectId: credential(environment, "VERCEL_PROJECT_ID"),
    };

    const provider = vercel({ persistent: true, ...credentials });

    return {
      provider,
      legacyWorkdir: async (id) => await (await provider.native(id).runCommand("pwd")).stdout(),
      // `update` replaces the whole port list, so the list is read fresh from Vercel and
      // changed one update at a time per sandbox. The SDK's handle gets the resulting routes.
      routePort: (id, port) =>
        oneAtATime(`vercel:${id}`, async () => {
          const handle = provider.native(id);

          if (handle.routes.some((route) => route.port === port)) return;
          const { Sandbox } = await import("@vercel/sandbox");
          const current = await Sandbox.get({ name: id, resume: false, ...credentials });
          const ports = current.routes.map((route) => route.port);

          await handle.update({ ports: ports.includes(port) ? ports : [...ports, port] });
        }),
      browser: { kind: "public" },
      stoppedWake: "fail",
      ports: [REMOTE_BROWSER_PORT],
    };
  },
  upstash: async (environment) => {
    const { upstash } = await import("@opencoredev/sandbox-sdk/upstash");

    const apiKey = credential(environment, "UPSTASH_BOX_API_KEY");
    const provider = upstash({ apiKey, public: false });

    return {
      provider,
      adopt: upstashAdoption(apiKey),
      peek: async (id) => {
        const { Box } = await import("@upstash/box");
        const listed = (await Box.list({ apiKey })).find((data) => data.id === id);

        if (!listed || listed.status === "deleted") return "missing";

        return listed.status === "paused"
          ? "paused"
          : listed.status === "running" || listed.status === "idle"
            ? "running"
            : "stopped";
      },
      legacyWorkdir: async (id) => (await provider.native(id).exec.command("pwd")).result,
      browser: { kind: "private" },
      stoppedWake: "fail",
    };
  },
  ascii: async (environment) => {
    const { asciiProvider } = await import("./AsciiProvider.ts");

    const provider = await asciiProvider(credential(environment, "BOX_API_KEY"));

    return {
      provider,
      // The old adapter sent commands without `cd`, so Ascii's own default directory applied.
      legacyWorkdir: async (id) => {
        const result = await provider
          .native(id)
          .command({ boxId: id, commandRequest: { command: "pwd", timeoutSeconds: 30 } });

        return result.type === "command.finished" && result.exitCode === 0 ? result.stdout : "";
      },
      browser: { kind: "private" },
      stoppedWake: "fail",
    };
  },
  railway: async (environment) => {
    const { railway } = await import("@opencoredev/sandbox-sdk/railway");

    const credentials = {
      token: credential(environment, "RAILWAY_API_TOKEN"),
      environmentId: credential(environment, "RAILWAY_ENVIRONMENT_ID"),
    };

    const provider = railway(credentials);

    return {
      provider,
      adopt: railwayAdoption(credentials),
      legacyWorkdir: async (id) => (await provider.native(id).exec("pwd")).stdout,
      browser: {
        kind: "none",
        reason:
          "Railway previews require a Railway CLI tunnel. Automatic bot browser routing is not supported; private VM addresses are not browser endpoints.",
      },
      // Railway has no pause or resume; a VM that is not running fails closed and is never replaced.
      stoppedWake: "fail",
    };
  },
  tenki: async (environment) => {
    const { tenki } = await import("@opencoredev/sandbox-sdk/tenki");

    const apiKey = credential(environment, "TENKI_API_KEY");
    const provider = tenki({ apiKey });

    // Public application previews must not expose the browser's unauthenticated MCP server.
    const browser = {
      kind: "none",
      reason:
        "Tenki sandbox browser requires an authenticated endpoint; public previews are not supported for browser control.",
    } as const;

    return {
      provider,
      legacyWorkdir: async (id) =>
        new TextDecoder().decode((await provider.native(id).exec(["pwd"])).stdout),
      browser,
      stoppedWake: "fail",
      // Sessions the old adapter made lack the SDK's metadata, which Tenki cannot add later.
      legacy: async () => {
        const { tenkiLegacyProvider } = await import("./TenkiLegacyProvider.ts");
        const shim = await tenkiLegacyProvider(apiKey);

        return {
          provider: shim,
          legacyWorkdir: async (id) =>
            new TextDecoder().decode((await shim.native(id).exec(["pwd"])).stdout),
          browser,
          stoppedWake: "fail",
        };
      },
    };
  },
  boat: async (environment) => {
    const { boat } = await import("@opencoredev/sandbox-sdk/boat");

    return {
      provider: boat({ apiKey: credential(environment, "BOAT_API_KEY") }),
      browser: { kind: "private" },
      // Boat pauses idle VMs itself and wakes them on the next API call.
      stoppedWake: "on-use",
    };
  },
  docker: async (environment) => {
    const { local } = await import("@opencoredev/sandbox-sdk/local");
    const dockerHost = environment.DOCKER_HOST?.trim();

    return {
      provider: local(dockerHost ? { dockerHost } : {}),
      browser: { kind: "loopback" },
      stoppedWake: "fail",
      ports: [3000, REMOTE_BROWSER_PORT],
    };
  },
};

export function sandboxBinding(
  sandbox: RemoteBotSandbox,
  environment: Environment = {},
): Promise<SandboxBinding> {
  return BINDINGS[sandbox](environment);
}

/** Durable VMs and containers that a failed session setup must never destroy. */
export const DURABLE_REMOTE_SANDBOXES: ReadonlySet<BotSandbox> = new Set([
  "railway",
  "tenki",
  "ascii",
  "boat",
  "docker",
]);

export function header(preview: Preview, name: string): string | undefined {
  const entry = Object.entries(preview.headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );

  return entry?.[1].trim() || undefined;
}

async function waitUntilRunning(provider: Provider, id: string) {
  const deadline = performance.now() + 300_000;

  while ((await provider.connect(id)).state !== "running") {
    if (performance.now() >= deadline) throw new Error(`Sandbox '${id}' did not start in time.`);
    await Effect.runPromise(Effect.sleep(2_000));
  }
}
