import * as Predicate from "effect/Predicate";
import type { CloudChannelRouteId, CloudForwardedRequest } from "@akeru/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";

import { CloudConnection } from "./CloudConnection.ts";

/** The part of a channel runtime entry the relay needs. Matches `ChannelRuntimeEntry.webhook`. */
export interface HostedChannelEntry {
  readonly webhook?: (request: Request) => Promise<Response>;
}

export interface HostedChannelMissed {
  readonly count: number;
  readonly since: string;
}

export interface HostedChannelRelayShape {
  /** Routes cloud-forwarded requests for `routeId` to the entry's webhook. Replaces any earlier entry. */
  readonly attach: (routeId: CloudChannelRouteId, entry: HostedChannelEntry) => Effect.Effect<void>;
  readonly detach: (routeId: CloudChannelRouteId) => Effect.Effect<void>;
  /** Deliveries the cloud dropped while this environment was offline, since the server started. */
  readonly missed: (routeId: CloudChannelRouteId) => Effect.Effect<HostedChannelMissed | undefined>;
}

export class HostedChannelRelay extends Context.Service<
  HostedChannelRelay,
  HostedChannelRelayShape
>()("akeru-bot/cloud/HostedChannelRelay") {}

// The URL only has to parse. Channel adapters verify signatures over the body and headers.
const RELAY_ORIGIN = "https://hosted-channel.akeru.invalid";

const DROPPED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);

const isDotSegment = (segment: string) => {
  let decoded: string;

  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return true;
  }

  return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
};

/**
 * The forwarded path comes from the cloud, so it must not climb out of the
 * route: no dot segments (plain or percent-encoded), fragments, backslashes,
 * or a leading `//` that would read as another host.
 */
export function isSafeForwardedPath(path: string) {
  if (path.includes("#") || path.includes("\\") || path.startsWith("//")) return false;
  const pathname = path.split("?", 1)[0]!;

  return !pathname.split("/").some((segment) => segment !== "" && isDotSegment(segment));
}

/** Rebuilds a forwarded request below the route's path, or returns null when it is malformed. */
export function toWebRequest(routeId: CloudChannelRouteId, forwarded: CloudForwardedRequest) {
  if (!isSafeForwardedPath(forwarded.path)) return null;
  const body = Encoding.decodeBase64(forwarded.bodyBase64);

  if (Predicate.isTagged(body, "Failure")) return null;

  const path =
    forwarded.path.startsWith("/") || forwarded.path === "" ? forwarded.path : `/${forwarded.path}`;

  const prefix = `/routes/${routeId}`;
  const url = new URL(`${RELAY_ORIGIN}${prefix}${path}`);

  if (url.origin !== RELAY_ORIGIN) return null;

  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  const headers = new Headers();

  for (const [name, value] of Object.entries(forwarded.headers)) {
    if (!DROPPED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }

  return new Request(url.href, {
    method: forwarded.method,
    headers,
    ...(forwarded.method === "POST" ? { body: body.success } : {}),
  });
}

export const make = Effect.gen(function* () {
  const connection = yield* CloudConnection;
  const entries = new Map<CloudChannelRouteId, HostedChannelEntry>();
  const missedByRoute = new Map<CloudChannelRouteId, HostedChannelMissed>();

  yield* connection.register("channel.inbound", (message) =>
    Effect.gen(function* () {
      const webhook = entries.get(message.routeId)?.webhook;

      if (!webhook) {
        return yield* Effect.logDebug("No hosted channel is attached for a relayed request", {
          routeId: message.routeId,
        });
      }

      const request = toWebRequest(message.routeId, message.request);

      if (!request) {
        return yield* Effect.logWarning("Dropped a malformed relayed request", {
          routeId: message.routeId,
        });
      }

      const response = yield* Effect.tryPromise(() => webhook(request));

      if (!response.ok) {
        yield* Effect.logWarning("Hosted channel webhook rejected a relayed request", {
          routeId: message.routeId,
          status: response.status,
        });
      }
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Hosted channel webhook failed", { routeId: message.routeId }),
      ),
    ),
  );

  yield* connection.register("channel.missed", (message) =>
    Effect.gen(function* () {
      const previous = missedByRoute.get(message.routeId);
      missedByRoute.set(message.routeId, {
        count: (previous?.count ?? 0) + message.count,
        since: previous?.since ?? message.since,
      });
      yield* Effect.logWarning("Akeru Cloud dropped hosted channel deliveries while offline", {
        routeId: message.routeId,
        provider: message.provider,
        count: message.count,
        since: message.since,
      });
    }),
  );

  return HostedChannelRelay.of({
    attach: (routeId, entry) => Effect.sync(() => void entries.set(routeId, entry)),
    detach: (routeId) =>
      Effect.sync(() => {
        entries.delete(routeId);
        missedByRoute.delete(routeId);
      }),
    missed: (routeId) => Effect.sync(() => missedByRoute.get(routeId)),
  });
});

export const layer = Layer.effect(HostedChannelRelay, make);
