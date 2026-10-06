import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CloudServerMessage } from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { makeD1, seedEnvironment } from "../../../test/fakes.ts";
import { ROUTES_PER_USER } from "../channels/routes.ts";
import {
  EnvironmentHubRuntime,
  type HubState,
  type HubEnv,
  type HubSocketAttachment,
} from "./hub.ts";

// Tests run in Node, where `cloudflare:workers` does not exist.
vi.mock("cloudflare:workers", () => import("../../../test/cloudflareWorkers.ts"));

const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(CloudServerMessage));

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  sent: CloudServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  #attachment: HubSocketAttachment = { environmentId: "env_1", userId: "user_1", welcomed: true };
  send(data: string) {
    this.sent.push(decodeMessage(data));
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
  }
  serializeAttachment(value: HubSocketAttachment) {
    this.#attachment = value;
  }
  deserializeAttachment() {
    return this.#attachment;
  }
}

// Node cannot construct an upgrade response; preserve its status for assertions.
function stubUpgrade() {
  const NodeResponse = Response;
  vi.stubGlobal(
    "Response",
    class extends NodeResponse {
      constructor(body: BodyInit | null, init: ResponseInit) {
        super(body, init.status === 101 ? { status: 200 } : init);

        if (init.status === 101) Object.defineProperty(this, "status", { value: 101 });
      }
    },
  );
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = new FakeSocket();
      1 = new FakeSocket();
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeHub() {
  const { db, query } = makeD1();
  seedEnvironment(query);
  const sockets: FakeSocket[] = [];
  const storage = new Map<string, unknown>();

  let gate: Promise<unknown> = Promise.resolve();

  const ctx = {
    blockConcurrencyWhile: <T>(callback: () => Promise<T>): Promise<T> => {
      const result = gate.then(callback);
      gate = result.catch(() => undefined);

      return result;
    },
    getWebSockets: () => sockets,
    waitUntil: () => {},
    acceptWebSocket: () => {},
    storage: {
      get: async <T>(key: string) => {
        // SAFETY: the runtime reads the same typed values it wrote at each storage key.
        return storage.get(key) as T | undefined;
      },
      put: async (
        key: string,
        value: { provider: string; count: number; since: string } | boolean,
      ) => void storage.set(key, value),
      delete: async (keys: string[]) =>
        keys.reduce((count, key) => count + Number(storage.delete(key)), 0),
      deleteAll: async () => storage.clear(),
      list: async <T>({ prefix }: { prefix: string }) => {
        // SAFETY: the runtime owns the typed missed-event values under this prefix.
        return new Map([...storage].filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
      },
    },
  } satisfies HubState;

  const env = {
    DB: db,
    CLOUD_PUBLIC_URL: "https://cloud.akeru.test",
    CLERK_PUBLISHABLE_KEY: "pk_test",
    SLACK_MANAGER_CLIENT_ID: "manager-client",
    SLACK_MANAGER_CLIENT_SECRET: "manager-secret",
    POSTHOG_KEY: "",
    POSTHOG_HOST: "https://us.i.posthog.com",
    KILL_SWITCH: "",
  } satisfies HubEnv;

  const hub = new EnvironmentHubRuntime(ctx, env);

  const connect = () => {
    const socket = new FakeSocket();
    sockets.push(socket);

    return socket;
  };

  const send = (socket: FakeSocket, message: Parameters<typeof JSON.stringify>[0]) =>
    hub.webSocketMessage(socket, JSON.stringify(message));

  return { hub, query, connect, send, storage, ctx, env };
}

const hello = {
  kind: "hello",
  v: 1,
  serverVersion: "1.3.0",
  environmentName: "Studio Mac",
  capabilities: ["hosted-channels"],
};

const inbound = {
  method: "POST" as const,
  path: "/",
  headers: {},
  bodyBase64: "e30=",
  receivedAt: "2026-09-29T12:00:00.000Z",
};

describe("heartbeat database budget", () => {
  it("clears encrypted link delivery when the environment confirms receipt with hello", async () => {
    const { query, connect, send } = makeHub();
    query(`INSERT INTO link_codes (device_code_hash, user_code, environment_name, server_version,
      expires_at, created_at, environment_id, token_ciphertext)
      VALUES ('hash', 'CODE', 'Mac', '1', '2026-09-29T12:10:00Z', '2026-09-29T12:00:00Z', 'env_1', 'cipher')`);
    await send(connect(), hello);
    expect(query("SELECT token_ciphertext FROM link_codes")).toEqual([{ token_ciphertext: null }]);
  });
  it("caches ping authorization for sixty seconds but checks privileged commands freshly", async () => {
    const { hub, connect, send, env, query } = makeHub();
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const socket = connect();
    await send(socket, hello);
    const prepare = vi.spyOn(env.DB, "prepare");

    for (let i = 0; i < 5; i++) await send(socket, { kind: "ping" });
    expect(prepare).not.toHaveBeenCalled();
    now += 60_000;
    await send(socket, { kind: "ping" });
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("SELECT 1"))).toHaveLength(1);
    query("UPDATE users SET disabled = 1");
    await send(socket, {
      kind: "channel.route.create",
      requestId: "blocked",
      provider: "slack",
      label: "Bot",
    });
    expect(socket.closed?.code).toBe(4001);
    expect(hub).toBeDefined();
  });

  it("closes a message flood before additional database work", async () => {
    const { connect, send, env } = makeHub();
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    const socket = connect();
    await send(socket, hello);

    for (let i = 0; i < 29; i++) await send(socket, { kind: "ping" });
    const prepare = vi.spyOn(env.DB, "prepare");
    await send(socket, hello);
    expect(socket.closed?.code).toBe(1008);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("EnvironmentHub", () => {
  it("welcomes an environment and records its version", async () => {
    const { connect, send, query } = makeHub();
    const socket = connect();
    await send(socket, hello);
    expect(socket.sent).toEqual([
      {
        kind: "welcome",
        v: 1,
        environmentId: "env_1",
        account: { email: "user_1@example.com" },
        capabilities: ["hosted-channels"],
      },
    ]);
    expect(query("SELECT server_version FROM environments")).toEqual([{ server_version: "1.3.0" }]);
  });

  it("revokes an environment whose account no longer exists", async () => {
    const { connect, send, query } = makeHub();
    // D1 enforces the foreign key; switch it off to simulate a deleted account.
    query("PRAGMA foreign_keys = OFF");
    query("DELETE FROM users");
    const socket = connect();
    await send(socket, hello);
    expect(socket.sent).toEqual([{ kind: "revoked" }]);
    expect(socket.closed).toEqual({ code: 4001, reason: "Revoked" });
  });

  it.each(["environment", "account"])("refuses hello after %s revocation", async (target) => {
    const { connect, send, query } = makeHub();
    const socket = connect();

    if (target === "environment") query("UPDATE environments SET revoked_at = '2026-10-05'");
    else query("UPDATE users SET disabled = 1");
    await send(socket, hello);
    expect(socket.sent).toEqual([{ kind: "revoked" }]);
    expect(socket.closed).toEqual({ code: 4001, reason: "Revoked" });
  });

  it("rejects a delayed upgrade even after the revoked hub restarts", async () => {
    stubUpgrade();
    const { hub, ctx, env } = makeHub();
    await hub.revoke();
    const restarted = new EnvironmentHubRuntime(ctx, env);

    const response = await restarted.fetch(
      new Request("https://cloud.test/connect", {
        headers: {
          upgrade: "websocket",
          "x-akeru-environment-id": "env_1",
          "x-akeru-user-id": "user_1",
        },
      }),
    );

    expect(response.status).toBe(410);
  });

  it("serializes a racing upgrade behind the durable revocation write", async () => {
    stubUpgrade();
    const { hub, ctx } = makeHub();
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const put = ctx.storage.put;
    vi.spyOn(ctx.storage, "put").mockImplementation(async (key, value) => {
      writing.resolve();
      await release.promise;
      await put(key, value);
    });
    const revoking = hub.revoke();
    await writing.promise;

    const upgrading = hub.fetch(
      new Request("https://cloud.test/connect", {
        headers: {
          upgrade: "websocket",
          "x-akeru-environment-id": "env_1",
          "x-akeru-user-id": "user_1",
        },
      }),
    );

    release.resolve();
    await revoking;
    expect((await upgrading).status).toBe(410);
  });

  it("answers ping and rejects malformed requests", async () => {
    const { connect, send } = makeHub();
    const socket = connect();
    await send(socket, { kind: "ping" });
    await send(socket, {
      kind: "channel.route.create",
      requestId: "r1",
      provider: "carrier-pigeon",
    });
    expect(socket.sent).toEqual([
      { kind: "pong" },
      {
        kind: "result",
        requestId: "r1",
        ok: false,
        code: "invalid-request",
        message: "Unrecognized request.",
      },
    ]);
  });

  it("rejects route and OAuth requests after an account is disabled", async () => {
    const { connect, send, query } = makeHub();
    const socket = connect();
    await send(socket, hello);
    socket.sent.length = 0;
    query("UPDATE users SET disabled = 1");
    await send(socket, {
      kind: "channel.route.create",
      requestId: "r",
      provider: "slack",
      label: "Ada",
    });
    await send(socket, { kind: "oauth.begin", requestId: "o", purpose: "slack.manager" });
    expect(socket.sent).toEqual([{ kind: "revoked" }]);
    expect(query("SELECT * FROM channel_routes")).toEqual([]);
    expect(query("SELECT * FROM oauth_flows")).toEqual([]);
    expect(socket.closed?.code).toBe(4001);
  });

  it("does not count unwelcomed sockets as online or deliver inbound events", async () => {
    const { hub, connect, send } = makeHub();
    const socket = connect();
    socket.serializeAttachment({ environmentId: "env_1", userId: "user_1" });
    expect(await hub.isOnline()).toBe(false);
    expect(await hub.relayInbound("rt_ada", "slack", inbound)).toBe("offline");
    expect(socket.sent).toEqual([]);
    await send(socket, hello);
    expect(await hub.isOnline()).toBe(true);
    expect(socket.sent).toContainEqual(
      expect.objectContaining({ kind: "channel.missed", count: 1 }),
    );
  });

  it("counts only active routes toward the per-user quota", async () => {
    const { connect, send, query } = makeHub();
    const socket = connect();

    for (let index = 0; index < ROUTES_PER_USER; index += 1) {
      await send(socket, {
        kind: "channel.route.create",
        requestId: `r${index}`,
        provider: "slack",
        label: "Old",
      });
    }

    query("UPDATE channel_routes SET disabled = 1");
    await send(socket, {
      kind: "channel.route.create",
      requestId: "new",
      provider: "slack",
      label: "New",
    });
    expect(socket.sent.at(-1)).toMatchObject({ requestId: "new", ok: true });
    expect(query("SELECT COUNT(*) AS count FROM channel_routes WHERE disabled = 0")).toEqual([
      { count: 1 },
    ]);
  });

  it("creates routes up to the per-user cap", async () => {
    const { connect, send, query } = makeHub();
    const socket = connect();

    for (let index = 0; index <= ROUTES_PER_USER; index += 1) {
      await send(socket, {
        kind: "channel.route.create",
        requestId: `r${index}`,
        provider: "slack",
        label: `Bot ${index}`,
      });
    }

    const first = socket.sent[0] as { ok: boolean; value: { route: Record<string, string> } };
    expect(first.ok).toBe(true);
    expect(first.value.route.routeId).toMatch(/^rt_[a-z0-9]{20}$/);
    expect(first.value.route.inboundUrl).toBe(
      `https://cloud.akeru.test/v1/channels/slack/${first.value.route.routeId}`,
    );
    expect(first.value.route.oauthRedirectUrl).toBe("https://cloud.akeru.test/v1/oauth/callback");
    expect(socket.sent.at(-1)).toMatchObject({ ok: false, code: "limit-reached" });
    expect(query("SELECT COUNT(*) AS count FROM channel_routes")).toEqual([
      { count: ROUTES_PER_USER },
    ]);
  });

  it("updates and deletes only its own routes", async () => {
    const { connect, send, query } = makeHub();
    seedEnvironment(query, { userId: "user_2", environmentId: "env_2", routeId: "rt_other" });
    const socket = connect();
    await send(socket, {
      kind: "channel.route.create",
      requestId: "c",
      provider: "slack",
      label: "Ada",
    });

    const routeId = (socket.sent[0] as { value: { route: { routeId: string } } }).value.route
      .routeId;

    await send(socket, {
      kind: "channel.route.update",
      requestId: "u",
      routeId,
      externalAppId: "A123",
      externalWorkspaceName: "Acme",
    });
    await send(socket, { kind: "channel.route.delete", requestId: "d", routeId: "rt_other" });
    expect(socket.sent[1]).toMatchObject({ requestId: "u", ok: true });
    expect(socket.sent[2]).toMatchObject({ requestId: "d", ok: false, code: "not-found" });
    expect(
      query(
        "SELECT external_app_id, external_workspace_name, label FROM channel_routes WHERE route_id = ?",
        routeId,
      ),
    ).toEqual([{ external_app_id: "A123", external_workspace_name: "Acme", label: "Ada" }]);
    await send(socket, { kind: "channel.route.delete", requestId: "d2", routeId });
    expect(socket.sent[3]).toEqual({
      kind: "result",
      requestId: "d2",
      ok: true,
      value: { type: "empty" },
    });
  });

  it("begins Slack OAuth with a hashed single-use state", async () => {
    const { connect, send, query } = makeHub();
    const socket = connect();
    await send(socket, { kind: "oauth.begin", requestId: "o", purpose: "slack.manager" });

    const result = socket.sent[0] as {
      ok: boolean;
      value: { state: string; redirectUri: string; authorizeUrl: string };
    };

    expect(result.ok).toBe(true);
    const authorize = new URL(result.value.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(authorize.searchParams.get("user_scope")).toBe("app_configurations:write");
    expect(authorize.searchParams.get("client_id")).toBe("manager-client");
    expect(authorize.searchParams.get("state")).toBe(result.value.state);
    expect(result.value.redirectUri).toBe("https://cloud.akeru.test/v1/oauth/callback");
    const flows = query("SELECT * FROM oauth_flows");
    expect(flows).toHaveLength(1);
    expect(JSON.stringify(flows)).not.toContain(result.value.state);

    await send(socket, { kind: "oauth.begin", requestId: "i", purpose: "slack.install" });
    expect(socket.sent[1]).toMatchObject({ requestId: "i", ok: false, code: "invalid-request" });
  });

  it("remembers events missed while offline and reports them on the next hello", async () => {
    const { hub, connect, send } = makeHub();
    expect(await hub.relayInbound("rt_ada", "slack", inbound)).toBe("offline");
    expect(
      await hub.relayInbound("rt_ada", "slack", {
        ...inbound,
        receivedAt: "2026-09-29T12:05:00.000Z",
      }),
    ).toBe("offline");
    const socket = connect();
    await send(socket, hello);
    expect(socket.sent[1]).toEqual({
      kind: "channel.missed",
      routeId: "rt_ada",
      provider: "slack",
      count: 2,
      since: "2026-09-29T12:00:00.000Z",
    });
    await send(socket, hello);
    expect(socket.sent.filter((message) => message.kind === "channel.missed")).toHaveLength(1);
  });

  it("relays to the newest open socket and rate limits bursts per route", async () => {
    const { hub, connect } = makeHub();
    const old = connect();
    old.readyState = WebSocket.CLOSING;
    const current = connect();
    let delivered = 0;
    let limited = 0;

    for (let index = 0; index < 40; index += 1) {
      const outcome = await hub.relayInbound("rt_ada", "slack", inbound);

      if (outcome === "delivered") delivered += 1;

      if (outcome === "rate-limited") limited += 1;
    }

    expect(delivered).toBeGreaterThanOrEqual(30);
    expect(limited).toBeGreaterThan(0);
    expect(old.sent).toEqual([]);
    expect(current.sent).toHaveLength(delivered);
    expect(await hub.relayInbound("rt_other", "slack", inbound)).toBe("delivered");
  });

  it("tells the environment it was revoked and closes the socket", async () => {
    const { hub, connect, send, query } = makeHub();
    const socket = connect();
    await hub.revoke();
    await send(socket, {
      kind: "channel.route.create",
      requestId: "late",
      provider: "slack",
      label: "Late",
    });
    expect(query("SELECT * FROM channel_routes")).toEqual([]);
    expect(socket.sent).toEqual([{ kind: "revoked" }]);
    expect(socket.closed).toEqual({ code: 4001, reason: "Revoked" });
    expect(await hub.isOnline()).toBe(false);
  });

  it("unlinks from the environment side, answers, then closes the socket", async () => {
    const { connect, send, query, storage } = makeHub();
    query(
      "INSERT INTO channel_routes (route_id, provider, environment_id, user_id, label, created_at) VALUES ('rt_ada', 'slack', 'env_1', 'user_1', 'Ada', '2026-09-01T00:00:00.000Z')",
    );
    query(
      "INSERT INTO oauth_flows (flow_id, state_hash, purpose, environment_id, expires_at) VALUES ('fl_1', 'h', 'slack.manager', 'env_1', '2026-09-30T00:00:00.000Z')",
    );
    storage.set("missed:rt_ada", { provider: "slack", count: 1, since: "2026-09-29T00:00:00Z" });
    const socket = connect();
    await send(socket, { kind: "environment.unlink", requestId: "u1" });
    expect(socket.sent).toEqual([
      { kind: "result", requestId: "u1", ok: true, value: { type: "empty" } },
    ]);
    expect(socket.closed).toEqual({ code: 4001, reason: "Unlinked" });
    expect(query("SELECT revoked_at IS NOT NULL AS revoked FROM environments")).toEqual([
      { revoked: 1 },
    ]);
    expect(query("SELECT disabled FROM channel_routes")).toEqual([{ disabled: 1 }]);
    expect(query("SELECT * FROM oauth_flows")).toEqual([]);
    expect([...storage]).toEqual([["revoked", true]]);
  });

  it("rejects requests when unlinking an already revoked environment", async () => {
    const { connect, send, query } = makeHub();
    query("UPDATE environments SET revoked_at = '2026-09-01T00:00:00.000Z'");
    const socket = connect();
    await send(socket, { kind: "environment.unlink", requestId: "u1" });
    expect(socket.sent).toEqual([{ kind: "revoked" }]);
  });
});
