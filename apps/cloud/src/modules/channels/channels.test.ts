import * as NodeBuffer from "node:buffer";

import type { CloudServerMessage } from "@akeru/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeDeps, seedEnvironment, testConfig } from "../../../test/fakes.ts";
import { createApp } from "../../app.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { MAX_INBOUND_BODY_BYTES } from "./index.ts";

const app = createApp();

const BASE = "https://cloud.akeru.test";

function slackEvent(path: string, body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-signature": "v0=abc",
      "x-slack-request-timestamp": "1790000000",
      cookie: "session=secret",
      "cf-connecting-ip": "203.0.113.9",
      ...headers,
    },
    body,
  });
}

describe("hosted channel inbound", () => {
  it("answers Slack URL verification without a route", async () => {
    const harness = makeDeps();

    const response = await app.fetch(
      slackEvent(
        "/v1/channels/slack/rt_unknown/events",
        JSON.stringify({ type: "url_verification", challenge: "abc123", token: "x" }),
      ),
      harness.deps,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "abc123" });
  });

  it("forwards the raw request with only content-type and Slack headers", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });

    const response = await app.fetch(
      slackEvent("/v1/channels/slack/rt_ada/events?retry=1", body),
      harness.deps,
    );

    expect(response.status).toBe(200);
    await harness.drain();
    expect(harness.hub("env_1").sent).toEqual([
      {
        kind: "channel.inbound",
        routeId: "rt_ada",
        provider: "slack",
        request: {
          method: "POST",
          path: "/events?retry=1",
          headers: {
            "content-type": "application/json",
            "x-slack-signature": "v0=abc",
            "x-slack-request-timestamp": "1790000000",
          },
          bodyBase64: NodeBuffer.Buffer.from(body).toString("base64"),
          receivedAt: "2026-09-29T12:00:00.000Z",
        },
      },
    ]);
    expect(harness.query("SELECT * FROM daily_usage")).toEqual([
      { route_id: "rt_ada", day: "2026-09-29", delivered: 1, dropped: 0 },
    ]);
    expect(harness.query("SELECT last_event_at FROM channel_routes")).toEqual([
      { last_event_at: "2026-09-29T12:00:00.000Z" },
    ]);
  });

  it("acknowledges and counts events while the environment is offline", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    harness.hub("env_1").online = false;

    for (let index = 0; index < 2; index += 1) {
      const response = await app.fetch(slackEvent("/v1/channels/slack/rt_ada", "{}"), harness.deps);
      expect(response.status).toBe(200);
    }

    await harness.drain();
    expect(harness.hub("env_1").missed).toBe(2);
    expect(harness.query("SELECT delivered, dropped FROM daily_usage")).toEqual([
      { delivered: 0, dropped: 2 },
    ]);
  });

  it("rejects unknown, mismatched, and disabled routes", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    const unknown = await app.fetch(slackEvent("/v1/channels/slack/rt_nope", "{}"), harness.deps);
    expect(unknown.status).toBe(404);
    const provider = await app.fetch(slackEvent("/v1/channels/teams/rt_ada", "{}"), harness.deps);
    expect(provider.status).toBe(404);
    harness.query("UPDATE channel_routes SET disabled = 1");
    const disabled = await app.fetch(slackEvent("/v1/channels/slack/rt_ada", "{}"), harness.deps);
    expect(disabled.status).toBe(410);
    expect(harness.hub("env_1").sent).toEqual([]);
  });

  it("rejects bodies over 1 MiB", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });

    const response = await app.fetch(
      slackEvent("/v1/channels/slack/rt_ada", "x".repeat(MAX_INBOUND_BODY_BYTES + 1)),
      harness.deps,
    );

    expect(response.status).toBe(413);
  });

  it("stops reading a chunked body as soon as it passes 1 MiB", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    const chunk = new Uint8Array(64 * 1024);
    let pulled = 0;

    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled += 1;

        if (pulled > 1_000) controller.close();
        else controller.enqueue(chunk);
      },
    });

    const request = new Request(`${BASE}/v1/channels/slack/rt_ada`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);

    expect(request.headers.get("content-length")).toBeNull();
    const response = await app.fetch(request, harness.deps);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(MAX_INBOUND_BODY_BYTES / chunk.byteLength + 4);
    expect(harness.hub("env_1").sent).toEqual([]);
  });

  it("forwards the exact body bytes, including ones that are not UTF-8", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80, 0x7d]);

    const response = await app.fetch(
      slackEvent("/v1/channels/slack/rt_ada/events", bytes),
      harness.deps,
    );

    expect(response.status).toBe(200);

    const sent = harness.hub("env_1").sent[0] as Extract<
      CloudServerMessage,
      { kind: "channel.inbound" }
    >;

    expect(new Uint8Array(NodeBuffer.Buffer.from(sent.request.bodyBase64, "base64"))).toEqual(
      bytes,
    );
  });

  it("relays Slack retries so the environment can recover events it never handled", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });

    const response = await app.fetch(
      slackEvent("/v1/channels/slack/rt_ada/events", JSON.stringify({ event_id: "Ev1" }), {
        "x-slack-retry-num": "1",
        "x-slack-retry-reason": "http_timeout",
      }),
      harness.deps,
    );

    expect(response.status).toBe(200);
    await harness.drain();
    expect(harness.hub("env_1").sent).toEqual([
      expect.objectContaining({
        kind: "channel.inbound",
        request: expect.objectContaining({
          headers: expect.objectContaining({
            "x-slack-retry-num": "1",
            "x-slack-retry-reason": "http_timeout",
          }),
        }),
      }),
    ]);
  });

  it("pauses relaying behind the kill switch", async () => {
    const harness = makeDeps();
    harness.deps = { ...harness.deps, config: { ...testConfig, killSwitch: true } };
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    const response = await app.fetch(slackEvent("/v1/channels/slack/rt_ada", "{}"), harness.deps);
    expect(response.status).toBe(503);
  });

  it("returns 429 when the hub rate limits a route", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    harness.hub("env_1").nextRelayOutcome = "rate-limited";
    const response = await app.fetch(slackEvent("/v1/channels/slack/rt_ada", "{}"), harness.deps);
    expect(response.status).toBe(429);
  });
});

async function seedFlow(
  harness: ReturnType<typeof makeDeps>,
  purpose: "slack.manager" | "slack.install",
  state: string,
  expiresAt = "2026-09-29T12:10:00.000Z",
) {
  harness.query(
    "INSERT INTO oauth_flows (flow_id, state_hash, purpose, environment_id, route_id, expires_at) VALUES (?, ?, ?, 'env_1', ?, ?)",
    "oa_1",
    await sha256Hex(state),
    purpose,
    purpose === "slack.install" ? "rt_ada" : null,
    expiresAt,
  );
}

const callback = (query: string) => new Request(`${BASE}/v1/oauth/callback?${query}`);

describe("oauth callback", () => {
  it("rejects unknown state", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    await seedFlow(harness, "slack.install", "right-state");
    const response = await app.fetch(callback("code=c&state=wrong-state"), harness.deps);
    expect(response.status).toBe(400);
    expect(harness.hub("env_1").sent).toEqual([]);
  });

  it("relays a Slack install code once and forgets the state", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    await seedFlow(harness, "slack.install", "install-state");

    const response = await app.fetch(
      callback("code=install-code&state=install-state"),
      harness.deps,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You can close this tab");
    expect(harness.hub("env_1").sent).toEqual([
      {
        kind: "oauth.completed",
        flowId: "oa_1",
        result: {
          purpose: "slack.install",
          routeId: "rt_ada",
          code: "install-code",
          redirectUri: `${BASE}/v1/oauth/callback`,
        },
      },
    ]);
    const replay = await app.fetch(callback("code=install-code&state=install-state"), harness.deps);
    expect(replay.status).toBe(400);
  });

  it("rejects expired state", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    await seedFlow(harness, "slack.install", "old-state", "2026-09-29T11:59:00.000Z");
    const response = await app.fetch(callback("code=c&state=old-state"), harness.deps);
    expect(response.status).toBe(400);
  });

  it("shows an error page when the environment is offline", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    await seedFlow(harness, "slack.install", "install-state");
    harness.hub("env_1").online = false;
    const response = await app.fetch(callback("code=c&state=install-state"), harness.deps);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("offline");
    harness.hub("env_1").online = true;
    expect((await app.fetch(callback("code=c&state=install-state"), harness.deps)).status).toBe(
      200,
    );
  });

  it("exchanges the Slack manager code and hands the token over without storing it", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query);
    await seedFlow(harness, "slack.manager", "manager-state");
    const fetchCalls: Array<{ url: string; body: string }> = [];
    harness.deps = {
      ...harness.deps,
      fetch: async (input, init) => {
        fetchCalls.push({ url: String(input), body: String(init?.body) });

        return Response.json({
          ok: true,
          authed_user: {
            id: "U1",
            access_token: "xoxe.xoxp-secret",
            refresh_token: "xoxe-1-r",
            expires_in: 43200,
          },
          team: { id: "T1", name: "Acme" },
        });
      },
    };

    const response = await app.fetch(
      callback("code=manager-code&state=manager-state"),
      harness.deps,
    );

    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(new URLSearchParams(fetchCalls[0]!.body).get("client_secret")).toBe("manager-secret");
    expect(harness.hub("env_1").sent).toEqual([
      {
        kind: "oauth.completed",
        flowId: "oa_1",
        result: {
          purpose: "slack.manager",
          accessToken: "xoxe.xoxp-secret",
          refreshToken: "xoxe-1-r",
          expiresInSeconds: 43200,
          teamId: "T1",
          teamName: "Acme",
          userId: "U1",
        },
      },
    ]);

    const tables = [
      "users",
      "environments",
      "link_codes",
      "channel_routes",
      "oauth_flows",
      "daily_usage",
    ];

    for (const table of tables) {
      expect(JSON.stringify(harness.query(`SELECT * FROM ${table}`))).not.toContain("xoxe");
    }
  });

  it("retries delivery without exchanging the single-use manager code again", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query);
    await seedFlow(harness, "slack.manager", "manager-state");

    const exchange = vi.fn(async () =>
      Response.json({
        ok: true,
        authed_user: { id: "U1", access_token: "xoxe-secret" },
        team: { id: "T1", name: "Acme" },
      }),
    );

    harness.deps = { ...harness.deps, fetch: exchange };
    const hub = harness.hub("env_1");
    const deliver = vi.spyOn(hub, "deliver").mockResolvedValueOnce(false);
    expect((await app.fetch(callback("code=once&state=manager-state"), harness.deps)).status).toBe(
      503,
    );
    const stored = JSON.stringify(harness.query("SELECT * FROM oauth_flows"));
    expect(stored).not.toContain("xoxe-secret");
    expect(stored).not.toContain("manager-state");
    expect((await app.fetch(callback("code=once&state=manager-state"), harness.deps)).status).toBe(
      200,
    );
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(hub.sent).toContainEqual(
      expect.objectContaining({
        kind: "oauth.completed",
        result: expect.objectContaining({ accessToken: "xoxe-secret" }),
      }),
    );
    expect(harness.query("SELECT * FROM oauth_flows")).toEqual([]);
  });

  it("serializes concurrent callbacks while the manager exchange is in flight", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query);
    await seedFlow(harness, "slack.manager", "manager-state");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    harness.deps = {
      ...harness.deps,
      fetch: async () => {
        started.resolve();
        await release.promise;

        return Response.json({ ok: false, error: "access_denied" });
      },
    };
    const first = app.fetch(callback("code=once&state=manager-state"), harness.deps);
    await started.promise;
    expect((await app.fetch(callback("code=once&state=manager-state"), harness.deps)).status).toBe(
      409,
    );
    release.resolve();
    expect((await first).status).toBe(200);
    expect(harness.hub("env_1").sent).toHaveLength(1);
  });

  it("passes a provider error through as a failed result", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query);
    await seedFlow(harness, "slack.manager", "manager-state");

    const response = await app.fetch(
      callback("error=access_denied&state=manager-state"),
      harness.deps,
    );

    expect(response.status).toBe(200);
    expect(harness.hub("env_1").sent).toEqual([
      {
        kind: "oauth.completed",
        flowId: "oa_1",
        result: { purpose: "slack.manager", error: "access_denied" },
      },
    ]);
  });
});
