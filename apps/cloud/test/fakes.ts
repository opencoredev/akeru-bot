import type { CloudStatement, CloudDatabase } from "../src/database.ts";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import { vi } from "vite-plus/test";

import { CloudChannelRouteId, type CloudServerMessage } from "@akeru/contracts";

import { noopAnalytics, type Analytics } from "../src/analytics.ts";
import type { CloudConfig } from "../src/config.ts";
import type { AuthenticatedUser, CloudDeps } from "../src/deps.ts";
import type { EnvironmentHubRpc, InboundRelayOutcome } from "../src/modules/environments/hubRpc.ts";

const migrationsDir = new URL("../migrations/", import.meta.url);

/** A D1 stand-in backed by in-memory SQLite with the real migrations applied. */
export function makeD1() {
  const sqlite = new NodeSqlite.DatabaseSync(":memory:");

  for (const file of NodeFS.readdirSync(migrationsDir).toSorted()) {
    sqlite.exec(NodeFS.readFileSync(new URL(file, migrationsDir), "utf8"));
  }

  const statement = (sql: string, params: NodeSqlite.SQLInputValue[] = []): CloudStatement => ({
    bind: (...values: NodeSqlite.SQLInputValue[]) => statement(sql, values),
    first: async <T>() => {
      // SAFETY: callers own the SQL projection and its matching row type in this test database.
      return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async <T>() => {
      // SAFETY: callers own the SQL projection and its matching row type in this test database.
      return { results: sqlite.prepare(sql).all(...params) as T[] };
    },
    run: async () => {
      const result = sqlite.prepare(sql).run(...params);

      return { results: [], success: true, meta: { changes: Number(result.changes) } };
    },
  });

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: CloudStatement[]) => {
      const results = [];

      sqlite.exec("BEGIN");

      try {
        for (const item of statements) results.push(await item.run());
        sqlite.exec("COMMIT");

        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } satisfies CloudDatabase;

  const query = <T>(sql: string, ...params: NodeSqlite.SQLInputValue[]) =>
    sqlite.prepare(sql).all(...params) as T[];

  return { db, query };
}

/** Records what a hub would have sent. Online by default. */
export class FakeHub implements EnvironmentHubRpc {
  online = true;
  revoked = false;
  sent: CloudServerMessage[] = [];
  missed = 0;
  nextRelayOutcome: InboundRelayOutcome | null = null;
  forwardedRequests: Request[] = [];

  async deliver(message: CloudServerMessage) {
    if (!this.online) return false;
    this.sent.push(message);

    return true;
  }
  async relayInbound(
    routeId: Parameters<EnvironmentHubRpc["relayInbound"]>[0],
    provider: Parameters<EnvironmentHubRpc["relayInbound"]>[1],
    request: Parameters<EnvironmentHubRpc["relayInbound"]>[2],
  ): Promise<InboundRelayOutcome> {
    if (this.nextRelayOutcome) return this.nextRelayOutcome;

    if (
      await this.deliver({
        kind: "channel.inbound",
        routeId: CloudChannelRouteId.make(routeId),
        provider,
        request,
      })
    ) {
      return "delivered";
    }

    this.missed += 1;

    return "offline";
  }
  async isOnline() {
    return this.online;
  }
  async revoke() {
    this.revoked = true;
    this.online = false;
  }
  async fetch(request: Request) {
    this.forwardedRequests.push(request);

    return new Response("upgraded");
  }
}

export const testConfig: CloudConfig = {
  publicUrl: "https://cloud.akeru.test",
  clerkPublishableKey: "pk_test_123",
  slackManager: { clientId: "manager-client", clientSecret: "manager-secret" },
  killSwitch: false,
};

/** Browser requests authenticate with `Authorization: Bearer user:<id>`; ids starting with `admin` are admins. */
export function authHeader(userId: string) {
  return { authorization: `Bearer user:${userId}` };
}

export function makeDeps(overrides: Partial<CloudDeps> = {}) {
  const { db, query } = makeD1();
  const hubs = new Map<string, FakeHub>();

  const hub = (environmentId: string) => {
    let existing = hubs.get(environmentId);

    if (!existing) {
      existing = new FakeHub();
      hubs.set(environmentId, existing);
    }

    return existing;
  };

  let now = new Date("2026-09-29T12:00:00.000Z");
  const captured: Array<{ event: string; userId: string }> = [];

  const analytics: Analytics = {
    capture: (event, userId) => {
      captured.push({ event, userId });
    },
  };

  const pending: Promise<unknown>[] = [];

  const deps: CloudDeps = {
    db,
    hubs: { get: hub },
    auth: {
      authenticate: async (request): Promise<AuthenticatedUser | null> => {
        const match = /^Bearer user:(.+)$/.exec(request.headers.get("authorization") ?? "");

        if (!match?.[1]) return null;
        const userId = match[1];

        return { userId, email: `${userId}@example.com`, isAdmin: userId.startsWith("admin") };
      },
    },
    analytics: overrides.analytics ?? analytics ?? noopAnalytics,
    config: testConfig,
    fetch: vi.fn<typeof fetch>(async () => new Response("unexpected fetch", { status: 500 })),
    now: () => now,
    waitUntil: (promise) => {
      pending.push(promise);
    },
    ...overrides,
  };

  return {
    deps,
    query,
    hub,
    captured,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    drain: () => Promise.all(pending),
  };
}

/** Seeds one user, one linked environment, and optionally one route. */
export function seedEnvironment(
  query: ReturnType<typeof makeD1>["query"],
  options: { userId?: string; environmentId?: string; routeId?: string; tokenHash?: string } = {},
) {
  const userId = options.userId ?? "user_1";
  const environmentId = options.environmentId ?? "env_1";
  query(
    "INSERT OR IGNORE INTO users (clerk_user_id, email, created_at) VALUES (?, ?, ?)",
    userId,
    `${userId}@example.com`,
    "2026-09-01T00:00:00.000Z",
  );
  query(
    "INSERT INTO environments (id, user_id, name, server_version, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    environmentId,
    userId,
    "Studio Mac",
    "1.2.3",
    options.tokenHash ?? `hash-${environmentId}`,
    "2026-09-01T00:00:00.000Z",
  );

  if (options.routeId) {
    query(
      "INSERT INTO channel_routes (route_id, provider, environment_id, user_id, label, created_at) VALUES (?, 'slack', ?, ?, 'Ada', ?)",
      options.routeId,
      environmentId,
      userId,
      "2026-09-01T00:00:00.000Z",
    );
  }

  return { userId, environmentId };
}
