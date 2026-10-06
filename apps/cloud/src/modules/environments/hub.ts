import {
  CLOUD_PROTOCOL_VERSION,
  CloudEnvironmentId,
  CloudEnvironmentMessage,
  CloudChannelRouteId,
  type CloudForwardedRequest,
  type CloudHostedChannelProvider,
  type CloudServerMessage,
} from "@akeru/contracts";
import { DurableObject } from "cloudflare:workers";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { CloudDatabase } from "../../database.ts";
import type { CloudWorkerEnv } from "../../env.ts";
import { createPostHogAnalytics } from "../../analytics.ts";
import { readConfig } from "../../config.ts";
import { decodeOrNull } from "../../lib/schema.ts";
import { beginOAuth } from "../channels/oauth.ts";
import {
  createRoute,
  deleteRoute,
  updateRoute,
  type EnvironmentOwner,
  type RequestOutcome,
} from "../channels/routes.ts";
import {
  ENVIRONMENT_ID_HEADER,
  USER_ID_HEADER,
  type EnvironmentHubRpc,
  type InboundRelayOutcome,
} from "./hubRpc.ts";
import { revokeEnvironment } from "./revoke.ts";

/** Capabilities this cloud offers over the socket. */
export const CLOUD_CAPABILITIES = ["hosted-channels"] as const;

const RATE_BURST = 30;

const RATE_PER_SECOND = 30;

const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

const MISSED_PREFIX = "missed:";

interface MissedEvents {
  readonly provider: CloudHostedChannelProvider;
  readonly count: number;
  readonly since: string;
}

/**
 * One instance per linked environment, addressed by environment id. Holds the
 * environment's single socket through the hibernation API, relays channel
 * events to it, and answers its requests.
 */
export interface HubSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code: number, reason: string): void;
  serializeAttachment(owner: EnvironmentOwner): void;
  deserializeAttachment(): EnvironmentOwner;
}

export interface HubState {
  getWebSockets(): HubSocket[];
  acceptWebSocket(socket: WebSocket): void;
  waitUntil(promise: Promise<unknown>): void;
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: MissedEvents): Promise<void>;
    delete(keys: string[]): Promise<number>;
    deleteAll(): Promise<void>;
    list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  };
}

export type HubEnv = { readonly DB: CloudDatabase } & Pick<
  CloudWorkerEnv,
  | "CLOUD_PUBLIC_URL"
  | "CLERK_PUBLISHABLE_KEY"
  | "SLACK_MANAGER_CLIENT_ID"
  | "SLACK_MANAGER_CLIENT_SECRET"
  | "POSTHOG_KEY"
  | "POSTHOG_HOST"
  | "KILL_SWITCH"
>;

const EnvironmentOwnerSchema = Schema.Struct({
  environmentId: Schema.String,
  userId: Schema.String,
});

const RequestIdentity = Schema.Struct({
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});

const decodeOwner = Schema.decodeUnknownSync(EnvironmentOwnerSchema);

export class EnvironmentHubRuntime implements EnvironmentHubRpc {
  readonly #ctx: HubState;
  readonly #env: HubEnv;
  constructor(ctx: HubState, env: HubEnv) {
    this.#ctx = ctx;
    this.#env = env;
  }
  #buckets = new Map<string, { tokens: number; updatedAt: number }>();
  #lastSeenWrite = 0;

  #services() {
    return {
      db: this.#env.DB,
      config: readConfig(this.#env),
      analytics: createPostHogAnalytics({
        key: this.#env.POSTHOG_KEY,
        host: this.#env.POSTHOG_HOST,
        waitUntil: (promise) => this.#ctx.waitUntil(promise),
      }),
      now: () => new Date(),
    };
  }

  #socket(): HubSocket | undefined {
    return this.#ctx.getWebSockets().findLast((socket) => socket.readyState === WebSocket.OPEN);
  }

  #send(socket: HubSocket, message: CloudServerMessage) {
    socket.send(JSON.stringify(message));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const environmentId = request.headers.get(ENVIRONMENT_ID_HEADER);
    const userId = request.headers.get(USER_ID_HEADER);

    if (!environmentId || !userId) return new Response("Bad Request", { status: 400 });

    // One socket per environment: a new connection replaces the old one.
    for (const previous of this.#ctx.getWebSockets()) {
      previous.close(4000, "Replaced by a newer connection");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.#ctx.acceptWebSocket(server);
    server.serializeAttachment({ environmentId, userId } satisfies EnvironmentOwner);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: HubSocket, data: string | ArrayBuffer): Promise<void> {
    if (!Predicate.isString(data)) return;
    let parsed: unknown;

    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    const owner = decodeOwner(socket.deserializeAttachment());
    const message = decodeOrNull(CloudEnvironmentMessage, parsed);

    if (!message) {
      const identity = decodeOrNull(RequestIdentity, parsed);

      if (identity) {
        const { requestId } = identity;
        this.#send(socket, {
          kind: "result",
          requestId,
          ok: false,
          code: "invalid-request",
          message: "Unrecognized request.",
        });
      }

      return;
    }

    const services = this.#services();

    switch (message.kind) {
      case "hello": {
        const account = await services.db
          .prepare("SELECT email FROM users WHERE clerk_user_id = ?")
          .bind(owner.userId)
          .first<{ email: string }>();

        // The connect endpoint joined the user, so a missing row means the account
        // was deleted since. `welcome` needs an email, and the link is dead anyway.
        if (!account) {
          this.#send(socket, { kind: "revoked" });
          socket.close(4001, "Revoked");

          return;
        }

        await services.db
          .prepare(
            "UPDATE environments SET name = ?, server_version = ?, last_seen_at = ? WHERE id = ?",
          )
          .bind(
            message.environmentName,
            message.serverVersion,
            services.now().toISOString(),
            owner.environmentId,
          )
          .run();
        this.#lastSeenWrite = Date.now();
        this.#send(socket, {
          kind: "welcome",
          v: CLOUD_PROTOCOL_VERSION,
          environmentId: CloudEnvironmentId.make(owner.environmentId),
          account: { email: account.email },
          capabilities: [...CLOUD_CAPABILITIES],
        });
        await this.#flushMissed(socket);

        return;
      }

      case "ping":
        this.#send(socket, { kind: "pong" });
        await this.#touchLastSeen();

        return;
      case "channel.route.create":
        return this.#reply(
          socket,
          message.requestId,
          createRoute(services, owner, message.provider, message.label),
        );
      case "channel.route.update":
        return this.#reply(socket, message.requestId, updateRoute(services, owner, message));
      case "channel.route.delete":
        return this.#reply(
          socket,
          message.requestId,
          deleteRoute(services, owner, message.routeId),
        );
      case "oauth.begin":
        return this.#reply(
          socket,
          message.requestId,
          beginOAuth(services, owner, message.purpose, message.routeId),
        );
      case "environment.unlink":
        return this.#unlink(socket, owner, message.requestId);
    }
  }

  /** Unlinks from the environment side: the same revoke as the account page, then close. */
  async #unlink(socket: HubSocket, owner: EnvironmentOwner, requestId: string) {
    const services = this.#services();

    const revoked = await revokeEnvironment(
      services.db,
      services.now(),
      owner.environmentId,
      owner.userId,
    );

    if (!revoked) {
      this.#send(socket, {
        kind: "result",
        requestId,
        ok: false,
        code: "not-found",
        message: "This environment is not linked.",
      });

      return;
    }

    services.analytics.capture("environment_revoked", owner.userId);
    this.#send(socket, { kind: "result", requestId, ok: true, value: { type: "empty" } });

    for (const open of this.#ctx.getWebSockets()) {
      try {
        open.close(4001, "Unlinked");
      } catch {
        // Already closed.
      }
    }

    await this.#ctx.storage.deleteAll();
  }

  async webSocketClose(socket: HubSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  async #reply(socket: HubSocket, requestId: string, outcome: Promise<RequestOutcome>) {
    let result: RequestOutcome;

    try {
      result = await outcome;
    } catch (error) {
      console.error(JSON.stringify({ event: "cloud.hub.request_failed", error: String(error) }));
      result = { ok: false, code: "internal", message: "Something went wrong." };
    }

    this.#send(
      socket,
      result.ok
        ? { kind: "result", requestId, ok: true, value: result.value }
        : { kind: "result", requestId, ok: false, code: result.code, message: result.message },
    );
  }

  async #touchLastSeen() {
    if (Date.now() - this.#lastSeenWrite < LAST_SEEN_WRITE_INTERVAL_MS) return;
    this.#lastSeenWrite = Date.now();
    const owner = decodeOrNull(EnvironmentOwnerSchema, this.#socket()?.deserializeAttachment());

    if (!owner) return;
    await this.#env.DB.prepare("UPDATE environments SET last_seen_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), owner.environmentId)
      .run();
  }

  async #flushMissed(socket: HubSocket) {
    const missed = await this.#ctx.storage.list<MissedEvents>({ prefix: MISSED_PREFIX });

    for (const [key, entry] of missed) {
      this.#send(socket, {
        kind: "channel.missed",
        routeId: CloudChannelRouteId.make(key.slice(MISSED_PREFIX.length)),
        provider: entry.provider,
        count: entry.count,
        since: entry.since,
      });
    }

    if (missed.size > 0) await this.#ctx.storage.delete([...missed.keys()]);
  }

  #takeToken(routeId: string): boolean {
    const now = Date.now();
    const bucket = this.#buckets.get(routeId) ?? { tokens: RATE_BURST, updatedAt: now };
    bucket.tokens = Math.min(
      RATE_BURST,
      bucket.tokens + ((now - bucket.updatedAt) / 1_000) * RATE_PER_SECOND,
    );
    bucket.updatedAt = now;
    this.#buckets.set(routeId, bucket);

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;

    return true;
  }

  async deliver(message: CloudServerMessage): Promise<boolean> {
    const socket = this.#socket();

    if (!socket) return false;
    this.#send(socket, message);

    return true;
  }

  async relayInbound(
    routeId: string,
    provider: CloudHostedChannelProvider,
    request: CloudForwardedRequest,
  ): Promise<InboundRelayOutcome> {
    if (!this.#takeToken(routeId)) return "rate-limited";

    const delivered = await this.deliver({
      kind: "channel.inbound",
      routeId: CloudChannelRouteId.make(routeId),
      provider,
      request,
    });

    if (delivered) return "delivered";
    const key = `${MISSED_PREFIX}${routeId}`;
    const previous = await this.#ctx.storage.get<MissedEvents>(key);
    await this.#ctx.storage.put(key, {
      provider,
      count: (previous?.count ?? 0) + 1,
      since: previous?.since ?? request.receivedAt,
    } satisfies MissedEvents);

    return "offline";
  }

  async isOnline(): Promise<boolean> {
    return this.#socket() !== undefined;
  }

  async revoke(): Promise<void> {
    for (const socket of this.#ctx.getWebSockets()) {
      try {
        this.#send(socket, { kind: "revoked" });
        socket.close(4001, "Revoked");
      } catch {
        // Already closed.
      }
    }

    await this.#ctx.storage.deleteAll();
  }
}

/** Cloudflare owns the hibernating state; the runtime is independently testable. */
export class EnvironmentHub extends DurableObject<CloudWorkerEnv> implements EnvironmentHubRpc {
  readonly #runtime = new EnvironmentHubRuntime(this.ctx, this.env);
  override fetch(request: Request) {
    return this.#runtime.fetch(request);
  }
  deliver(message: CloudServerMessage) {
    return this.#runtime.deliver(message);
  }
  relayInbound(...args: Parameters<EnvironmentHubRpc["relayInbound"]>) {
    return this.#runtime.relayInbound(...args);
  }
  isOnline() {
    return this.#runtime.isOnline();
  }
  revoke() {
    return this.#runtime.revoke();
  }
  override webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    return this.#runtime.webSocketMessage(socket, data);
  }
  override webSocketClose(socket: WebSocket, code: number, reason: string) {
    return this.#runtime.webSocketClose(socket, code, reason);
  }
}
