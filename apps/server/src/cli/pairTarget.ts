import * as Predicate from "effect/Predicate";
import { ExecutionEnvironmentDescriptor } from "@akeru/contracts";
import { resolveWorktreeT3Home } from "@akeru/shared/devHome";
import {
  buildTailscaleHttpsBaseUrl,
  ensureTailscaleServe,
  readTailscaleStatus,
} from "@akeru/tailscale";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  type PersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  formatHostForUrl,
  isLoopbackHost,
  isWildcardHost,
  resolveHeadlessConnectionString,
} from "../startupAccess.ts";
import { aliasedEnv } from "./envAliases.ts";
import {
  WELL_KNOWN_ENVIRONMENT_PATH,
  PAIR_PROBE_TIMEOUT,
  TAILSCALE_PROBE_ATTEMPTS,
  TAILSCALE_PROBE_RETRY_DELAY,
  type PairStateVariant,
  DEV_VARIANT_PLACEHOLDER_URL,
  NoRunningServerError,
  TailscaleUnavailableError,
  MagicDnsNameMissingError,
  ServesOtherEnvironmentError,
  TailscaleServeFailedError,
  ServePortOccupiedError,
  InvalidPublicUrlError,
  PublicUrlWithTailscaleError,
  DevServerNotProxiableError,
  isDevServerNotProxiableError,
} from "./pairTypes.ts";
/**
 * The origin a user-managed tunnel or reverse proxy serves this server on. The web app lives at the
 * root of that origin, so anything beyond an http(s) origin is rejected rather than silently
 * dropped.
 */
export const parsePublicPairingBaseUrl = (raw: string): string | InvalidPublicUrlError => {
  const invalid = (reason: string) => new InvalidPublicUrlError({ publicUrl: raw, reason });
  if (!URL.canParse(raw)) {
    return invalid("is not a URL");
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return invalid("must use http or https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return invalid("must not contain credentials");
  }
  if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
    return invalid("must be an origin without a path, query, or fragment");
  }
  return url.origin;
};

export const resolvePublicPairingBaseUrl = Effect.fn("pair.resolvePublicPairingBaseUrl")(
  function* (input: { readonly publicUrl: Option.Option<string>; readonly tailscale: boolean }) {
    if (Option.isNone(input.publicUrl)) {
      return undefined;
    }
    if (input.tailscale) {
      return yield* new PublicUrlWithTailscaleError();
    }
    const parsed = parsePublicPairingBaseUrl(input.publicUrl.value);
    if (typeof parsed === "string") {
      return parsed;
    }
    return yield* parsed;
  },
);

/** The URL a browser or phone should pair through, absent Tailscale. */
export const resolveDirectPairingBaseUrl = (state: PersistedServerRuntimeState): string =>
  state.devUrl ?? resolveHeadlessConnectionString(state.host, state.port);

/**
 * The local endpoint Tailscale Serve should proxy to. Dev servers are
 * single-origin, so the web dev server's port is the one to publish; the
 * backend rides along behind Vite's proxy. Serve targets are always plain
 * HTTP, so an HTTPS dev URL cannot be proxied and is rejected.
 */
export const resolveTailscaleLocalTarget = (
  state: PersistedServerRuntimeState,
): { readonly localPort: number; readonly localHost?: string } | DevServerNotProxiableError => {
  if (state.devUrl !== undefined) {
    const devUrl = new URL(state.devUrl);
    if (devUrl.protocol !== "http:") {
      return new DevServerNotProxiableError({ devUrl: state.devUrl });
    }
    const localPort = devUrl.port.length > 0 ? Number.parseInt(devUrl.port, 10) : 80;
    return isLoopbackHost(devUrl.hostname)
      ? { localPort }
      : { localPort, localHost: devUrl.hostname };
  }
  // A server bound to one specific interface does not answer on loopback, so
  // the proxy has to target that interface directly.
  if (state.host !== undefined && !isWildcardHost(state.host) && !isLoopbackHost(state.host)) {
    return { localPort: state.port, localHost: formatHostForUrl(state.host) };
  }
  return { localPort: state.port };
};

export /**
 * Three outcomes, because they drive different decisions: a T3 descriptor
 * (pair with it), nothing answering (safe to configure Tailscale Serve), or
 * something answering that is not a T3 server (do NOT overwrite its mapping).
 */
type EnvironmentProbeResult =
  | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptor }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "not-a-t3-server" };

export const probeEnvironmentDescriptor = (
  baseUrl: string,
): Effect.Effect<EnvironmentProbeResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(new URL(WELL_KNOWN_ENVIRONMENT_PATH, baseUrl).toString());
    const response = yield* client.execute(request).pipe(
      Effect.timeout(PAIR_PROBE_TIMEOUT),
      // Transport failure or timeout: nothing (reachable) is listening there.
      Effect.mapError(() => ({ _tag: "unreachable" }) as const),
    );
    // Bad-gateway family means a proxy (Tailscale Serve) answered for a
    // backend that is gone — a stale mapping, not a live occupant. Treating
    // it as unreachable lets `akeru pair --tailscale` repair its own mapping
    // after the server's port changed.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return { _tag: "unreachable" } as const;
    }
    // Anything else that answered HTTP but not with a valid descriptor is
    // some other service.
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => ({ _tag: "not-a-t3-server" }) as const),
    );
    return { _tag: "descriptor", descriptor } as const;
  }).pipe(Effect.catch((outcome) => Effect.succeed(outcome)));

export // signal 0 delivers nothing; it only reports whether the pid exists. EPERM
// means it exists but belongs to another user, which still counts as alive.
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export interface DiscoveredPairTarget {
  readonly baseDir: string;
  readonly variant: PairStateVariant;
  readonly state: PersistedServerRuntimeState;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

export const discoverPairTarget = Effect.fn("pair.discoverPairTarget")(function* (
  explicitBaseDir: string | undefined,
) {
  const bases: Array<string> = [];
  if (explicitBaseDir !== undefined && explicitBaseDir.trim().length > 0) {
    bases.push(yield* resolveBaseDir(explicitBaseDir));
  } else {
    // Same precedence as dev-runner: inside a linked worktree its own `.akeru`
    // outranks the shared home, so `akeru pair` in a worktree pairs with the dev
    // server under test rather than the daily-driver install.
    const worktreeHome = yield* resolveWorktreeT3Home(process.cwd());
    if (worktreeHome !== undefined) {
      bases.push(worktreeHome);
    }
    const envHome = yield* aliasedEnv(Config.string, "HOME");
    bases.push(yield* resolveBaseDir(Option.getOrUndefined(envHome)));
  }

  const checkedStatePaths: Array<string> = [];
  for (const baseDir of new Set(bases)) {
    for (const variant of ["userdata", "dev"] as const) {
      const derivedPaths = yield* ServerConfig.deriveServerPaths(
        baseDir,
        variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
        {},
      );
      const statePath = derivedPaths.serverRuntimeStatePath;
      checkedStatePaths.push(statePath);
      const state = yield* readPersistedServerRuntimeState(statePath);
      if (Option.isNone(state)) {
        continue;
      }
      // The pid check guards against a dead server's state file whose port
      // was since reused by a different server: pairing would then mint a
      // token in the old database while the QR code points at the new server.
      if (!isProcessAlive(state.value.pid)) {
        continue;
      }
      const probed = yield* probeEnvironmentDescriptor(state.value.origin);
      if (!Predicate.isTagged(probed, "descriptor")) {
        continue;
      }
      return {
        baseDir,
        variant,
        state: state.value,
        descriptor: probed.descriptor,
      } satisfies DiscoveredPairTarget;
    }
  }
  return yield* new NoRunningServerError({ checkedStatePaths });
});

export const awaitEnvironmentDescriptor = Effect.fn(function* (baseUrl: string) {
  let last: EnvironmentProbeResult = { _tag: "unreachable" };
  for (let attempt = 0; attempt < TAILSCALE_PROBE_ATTEMPTS; attempt += 1) {
    last = yield* probeEnvironmentDescriptor(baseUrl);
    if (Predicate.isTagged(last, "descriptor")) {
      return last;
    }
    yield* Effect.sleep(TAILSCALE_PROBE_RETRY_DELAY);
  }
  return last;
});

export const resolveTailscalePairingBase = Effect.fn("pair.resolveTailscalePairingBase")(
  function* (input: { readonly target: DiscoveredPairTarget; readonly servePort: number }) {
    const notes: Array<string> = [];
    const status = yield* readTailscaleStatus.pipe(
      Effect.mapError((cause) => new TailscaleUnavailableError({ cause })),
    );
    if (status.magicDnsName === null) {
      return yield* new MagicDnsNameMissingError();
    }
    const baseUrl = buildTailscaleHttpsBaseUrl({
      magicDnsName: status.magicDnsName,
      servePort: input.servePort,
    });

    // Only an unreachable port, or a mapping already fronting this exact
    // environment, is safe to (re)configure. Any other responder — T3 or not
    // — must not have its mapping silently replaced.
    const existing = yield* probeEnvironmentDescriptor(baseUrl);
    if (Predicate.isTagged(existing, "descriptor")) {
      if (existing.descriptor.environmentId !== input.target.descriptor.environmentId) {
        return yield* new ServesOtherEnvironmentError({ servePort: input.servePort });
      }
      // Matching environment id proves the mapping reaches this server, but
      // not through which port: for a dev server it may front the backend
      // (whose /.well-known also answers) while /pair only renders through
      // the web origin. Reuse as-is for regular servers; fall through and
      // repoint our own mapping at the web port for dev servers.
      if (input.target.state.devUrl === undefined) {
        return { baseUrl, notes };
      }
    }
    if (Predicate.isTagged(existing, "not-a-t3-server")) {
      return yield* new ServePortOccupiedError({ servePort: input.servePort });
    }

    const localTarget = resolveTailscaleLocalTarget(input.target.state);
    if (isDevServerNotProxiableError(localTarget)) {
      return yield* localTarget;
    }
    yield* ensureTailscaleServe({
      localPort: localTarget.localPort,
      servePort: input.servePort,
      ...(localTarget.localHost !== undefined ? { localHost: localTarget.localHost } : {}),
    }).pipe(
      Effect.mapError(
        (cause) => new TailscaleServeFailedError({ servePort: input.servePort, cause }),
      ),
    );
    notes.push(
      `Tailscale Serve now maps ${baseUrl} to this server and persists across restarts. Remove it with \`tailscale serve --https=${String(input.servePort)} off\`.`,
    );

    const probed = yield* awaitEnvironmentDescriptor(baseUrl);
    if (Predicate.isTagged(probed, "descriptor")) {
      if (probed.descriptor.environmentId !== input.target.descriptor.environmentId) {
        return yield* new ServesOtherEnvironmentError({ servePort: input.servePort });
      }
    } else {
      notes.push(
        "The HTTPS endpoint has not answered yet. First use can take a moment while Tailscale provisions certificates.",
      );
    }
    return { baseUrl, notes };
  },
);
