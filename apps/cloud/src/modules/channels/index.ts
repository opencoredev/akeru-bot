import * as NodeBuffer from "node:buffer";

import type { CloudForwardedRequest } from "@akeru/contracts";
import type { Context } from "hono";

import type { CloudDeps, CloudHono } from "../../deps.ts";
import type { InboundRelayOutcome } from "../environments/hubRpc.ts";
import { registerOAuthCallback } from "./oauth.ts";
import { hostedChannelProviders, isHostedChannelProvider } from "./providers.ts";

export const MAX_INBOUND_BODY_BYTES = 1024 * 1024;

interface InboundRouteRow {
  readonly provider: string;
  readonly environment_id: string;
  readonly disabled: number;
  readonly revoked_at: string | null;
}

/** Reads the body with a running cap, stopping as soon as it grows past the limit. */
async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");

  if (declared > MAX_INBOUND_BODY_BYTES) return null;

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    size += value.byteLength;

    if (size > MAX_INBOUND_BODY_BYTES) {
      await reader.cancel();

      return null;
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function recordUsage(
  deps: CloudDeps,
  routeId: string,
  outcome: InboundRelayOutcome,
): ReturnType<CloudDeps["db"]["batch"]> {
  const now = deps.now().toISOString();
  const delivered = outcome === "delivered" ? 1 : 0;

  return deps.db.batch([
    deps.db
      .prepare(
        `INSERT INTO daily_usage (route_id, day, delivered, dropped) VALUES (?, ?, ?, ?)
         ON CONFLICT(route_id, day) DO UPDATE SET
           delivered = delivered + excluded.delivered,
           dropped = dropped + excluded.dropped`,
      )
      .bind(routeId, now.slice(0, 10), delivered, 1 - delivered),
    deps.db
      .prepare("UPDATE channel_routes SET last_event_at = ? WHERE route_id = ?")
      .bind(now, routeId),
  ]);
}

/**
 * Hosted channels. A provider such as Slack posts to a route's public URL; the
 * cloud forwards the raw request to the owning environment over its socket and
 * acknowledges at once. The environment verifies signatures and does the work.
 */
export function registerChannels(app: CloudHono) {
  const inbound = async (c: Context<{ Bindings: CloudDeps }>) => {
    const deps = c.env;

    if (deps.config.killSwitch) return c.text("Hosted channels are paused.", 503);
    const provider = c.req.param("provider") ?? "";
    const routeId = c.req.param("routeId") ?? "";

    if (!isHostedChannelProvider(provider)) return c.text("Not Found", 404);
    const method = c.req.method;

    if (method !== "GET" && method !== "POST") return c.text("Method Not Allowed", 405);
    const body = await readBoundedBody(c.req.raw);

    if (body === null) return c.text("Payload Too Large", 413);

    const module = hostedChannelProviders[provider];
    const preflight = module.preflight?.(new TextDecoder().decode(body));

    if (preflight) return preflight;

    const route = await deps.db
      .prepare(
        `SELECT r.provider, r.environment_id, r.disabled, e.revoked_at
         FROM channel_routes r JOIN environments e ON e.id = r.environment_id
         WHERE r.route_id = ?`,
      )
      .bind(routeId)
      .first<InboundRouteRow>();

    if (!route || route.provider !== provider) return c.text("Not Found", 404);

    if (route.disabled === 1 || route.revoked_at) return c.text("Gone", 410);

    const url = new URL(c.req.url);
    const prefix = `/v1/channels/${provider}/${routeId}`;
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, name) => {
      const lower = name.toLowerCase();

      if (module.forwardsHeader(lower)) headers[lower] = value;
    });

    const request: CloudForwardedRequest = {
      method,
      path: `${url.pathname.slice(prefix.length) || "/"}${url.search}`.slice(0, 2_048),
      headers,
      bodyBase64: NodeBuffer.Buffer.from(body).toString("base64"),
      receivedAt: deps.now().toISOString(),
    };

    const outcome = await deps.hubs
      .get(route.environment_id)
      .relayInbound(routeId, provider, request);

    deps.waitUntil(recordUsage(deps, routeId, outcome));

    // Offline events are acknowledged anyway: the environment hears how many it
    // missed when it reconnects, and providers disable URLs that keep failing.
    if (outcome === "rate-limited") return c.text("Too Many Requests", 429);

    return c.body(null, 200);
  };

  app.all("/v1/channels/:provider/:routeId", inbound);
  app.all("/v1/channels/:provider/:routeId/*", inbound);
  registerOAuthCallback(app);
}
