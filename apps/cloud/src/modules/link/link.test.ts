import { describe, expect, it, vi } from "vite-plus/test";

import { authHeader, makeDeps } from "../../../test/fakes.ts";
import { createApp } from "../../app.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { LINK_CODE_TTL_MS, LINK_DELIVERY_GRACE_MS } from "./index.ts";

const app = createApp();

const BASE = "https://cloud.akeru.test";

function post(
  path: string,
  body: Parameters<typeof JSON.stringify>[0],
  headers: Record<string, string> = {},
) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function startLink(harness: ReturnType<typeof makeDeps>) {
  const response = await app.fetch(
    post("/v1/link/start", { environmentName: "Studio Mac", serverVersion: "1.2.3" }),
    harness.deps,
  );

  expect(response.status).toBe(200);

  return (await response.json()) as {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresAt: string;
    pollIntervalSeconds: number;
  };
}

async function poll(harness: ReturnType<typeof makeDeps>, deviceCode: string) {
  const response = await app.fetch(post("/v1/link/poll", { deviceCode }), harness.deps);

  return (await response.json()) as {
    status: string;
    environmentToken?: string;
    environmentId?: string;
  };
}

describe("device link", () => {
  it("uses an independent token and expires the encrypted delivery after first-poll grace", async () => {
    const harness = makeDeps();
    const started = await startLink(harness);
    await app.fetch(
      post("/api/link/approve", { userCode: started.userCode }, authHeader("user_1")),
      harness.deps,
    );
    const approved = await poll(harness, started.deviceCode);
    expect(approved.status).toBe("approved");
    expect(approved.environmentToken).not.toBe(
      await sha256Hex(`environment-token:${started.deviceCode}`),
    );
    expect(JSON.stringify(harness.query("SELECT * FROM link_codes"))).not.toContain(
      approved.environmentToken,
    );
    harness.advance(LINK_DELIVERY_GRACE_MS);
    expect(await poll(harness, started.deviceCode)).toEqual({ status: "expired" });
    expect(harness.query("SELECT token_ciphertext FROM link_codes")).toEqual([
      { token_ciphertext: null },
    ]);
    expect(harness.query("SELECT * FROM environments")).toHaveLength(1);
  });

  it("isolates outstanding admission and start rates by caller", async () => {
    const harness = makeDeps();

    const start = (ip: string) =>
      app.fetch(
        post(
          "/v1/link/start",
          { environmentName: "Mac", serverVersion: "1" },
          { "CF-Connecting-IP": ip },
        ),
        harness.deps,
      );

    for (let i = 0; i < 5; i++) expect((await start("192.0.2.1")).status).toBe(200);
    expect((await start("192.0.2.1")).status).toBe(429);
    expect((await start("192.0.2.2")).status).toBe(200);

    for (let i = 0; i < 5; i++) {
      harness.query("DELETE FROM link_codes");
      expect((await start("192.0.2.1")).status).toBe(200);
    }

    harness.query("DELETE FROM link_codes");
    expect((await start("192.0.2.1")).status).toBe(429);
    expect((await start("192.0.2.2")).status).toBe(200);
    harness.advance(60_000);
    expect((await start("192.0.2.1")).status).toBe(200);
  });
  it("starts a flow and stores only the device code hash", async () => {
    const harness = makeDeps();
    const started = await startLink(harness);
    expect(started.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.verificationUrl).toBe(`${BASE}/link?code=${started.userCode}`);
    expect(started.pollIntervalSeconds).toBe(3);
    expect(Date.parse(started.expiresAt) - Date.parse("2026-09-29T12:00:00.000Z")).toBe(
      LINK_CODE_TTL_MS,
    );
    const rows = harness.query<{ device_code_hash: string }>("SELECT * FROM link_codes");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.device_code_hash).toBe(await sha256Hex(started.deviceCode));
    expect(JSON.stringify(rows)).not.toContain(started.deviceCode);
  });

  it("rejects malformed start requests", async () => {
    const harness = makeDeps();
    const response = await app.fetch(post("/v1/link/start", { environmentName: "" }), harness.deps);
    expect(response.status).toBe(400);
  });

  it("replays the same environment token after browser approval", async () => {
    const harness = makeDeps();
    const started = await startLink(harness);
    expect(await poll(harness, started.deviceCode)).toEqual({ status: "pending" });

    const preview = await app.fetch(
      new Request(`${BASE}/api/link?code=${started.userCode.toLowerCase().replace("-", "")}`, {
        headers: authHeader("user_1"),
      }),
      harness.deps,
    );

    expect(await preview.json()).toMatchObject({ environmentName: "Studio Mac" });

    const approve = await app.fetch(
      post("/api/link/approve", { userCode: started.userCode }, authHeader("user_1")),
      harness.deps,
    );

    expect(approve.status).toBe(200);

    const approved = await poll(harness, started.deviceCode);
    expect(approved).toMatchObject({
      status: "approved",
      account: { email: "user_1@example.com" },
    });
    const token = approved.environmentToken as string;

    const environments = harness.query<{ id: string; token_hash: string; user_id: string }>(
      "SELECT * FROM environments",
    );

    expect(environments).toEqual([
      expect.objectContaining({
        id: approved.environmentId,
        user_id: "user_1",
        token_hash: await sha256Hex(token),
      }),
    ]);
    expect(JSON.stringify(environments)).not.toContain(token);
    expect(harness.captured).toContainEqual({ event: "environment_linked", userId: "user_1" });

    // A lost response can be retried without minting another environment.
    expect(await poll(harness, started.deviceCode)).toEqual(approved);
    expect(harness.query("SELECT * FROM environments")).toHaveLength(1);
  });

  it("retries an approved poll after an environment insert fails", async () => {
    const harness = makeDeps();
    const started = await startLink(harness);
    await app.fetch(
      post("/api/link/approve", { userCode: started.userCode }, authHeader("user_1")),
      harness.deps,
    );
    harness.query(
      "CREATE TRIGGER fail_environment BEFORE INSERT ON environments BEGIN SELECT RAISE(FAIL, 'temporary failure'); END",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (await app.fetch(post("/v1/link/poll", { deviceCode: started.deviceCode }), harness.deps))
        .status,
    ).toBe(500);
    harness.query("DROP TRIGGER fail_environment");
    expect(await poll(harness, started.deviceCode)).toMatchObject({ status: "approved" });
    expect(harness.query("SELECT * FROM environments")).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("caps anonymous outstanding codes and frees capacity after expiry", async () => {
    const harness = makeDeps();
    harness.query(`WITH RECURSIVE codes(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM codes WHERE n < 10000)
      INSERT INTO link_codes (device_code_hash, user_code, environment_name, server_version, expires_at, created_at)
      SELECT 'hash-' || n, 'code-' || n, 'Mac', '1', '2026-09-29T12:10:00.000Z', '2026-09-29T12:00:00.000Z' FROM codes`);

    const response = await app.fetch(
      post("/v1/link/start", { environmentName: "Mac", serverVersion: "1" }),
      harness.deps,
    );

    expect(response.status).toBe(429);
    expect(harness.query("SELECT * FROM link_codes")).toHaveLength(10000);
    harness.advance(LINK_CODE_TTL_MS);
    expect(await startLink(harness)).toHaveProperty("deviceCode");
    expect(harness.query("SELECT * FROM link_codes")).toHaveLength(1);
  });

  it("does not return a revoked token on repeated approval polls", async () => {
    const harness = makeDeps();
    const started = await startLink(harness);
    await app.fetch(
      post("/api/link/approve", { userCode: started.userCode }, authHeader("user_1")),
      harness.deps,
    );
    expect(await poll(harness, started.deviceCode)).toMatchObject({ status: "approved" });
    harness.query("UPDATE environments SET revoked_at = '2026-09-29T12:00:00.000Z'");
    expect(await poll(harness, started.deviceCode)).toEqual({ status: "denied" });
  });

  it("expires unapproved codes and refuses late approval", async () => {
    const harness = makeDeps();
    const started = await startLink(harness);
    harness.advance(LINK_CODE_TTL_MS);
    expect(await poll(harness, started.deviceCode)).toEqual({ status: "expired" });

    const approve = await app.fetch(
      post("/api/link/approve", { userCode: started.userCode }, authHeader("user_1")),
      harness.deps,
    );

    expect(approve.status).toBe(404);
  });

  it("refuses to claim an approved code after it expires", async () => {
    const harness = makeDeps();
    const started = await startLink(harness);
    await app.fetch(
      post("/api/link/approve", { userCode: started.userCode }, authHeader("user_1")),
      harness.deps,
    );
    harness.advance(LINK_CODE_TTL_MS);
    expect(await poll(harness, started.deviceCode)).toEqual({ status: "expired" });
    expect(harness.query("SELECT * FROM environments")).toHaveLength(0);
  });

  it("reports denial", async () => {
    const harness = makeDeps();
    const started = await startLink(harness);
    await app.fetch(
      post("/api/link/deny", { userCode: started.userCode }, authHeader("user_1")),
      harness.deps,
    );
    expect(await poll(harness, started.deviceCode)).toEqual({ status: "denied" });
  });

  it("requires a signed-in browser to approve", async () => {
    const harness = makeDeps();
    const started = await startLink(harness);

    const response = await app.fetch(
      post("/api/link/approve", { userCode: started.userCode }),
      harness.deps,
    );

    expect(response.status).toBe(401);
    expect(await poll(harness, started.deviceCode)).toEqual({ status: "pending" });
  });

  it("rejects a cookie-only approval even when the session cookie is valid", async () => {
    // An authenticator that honors cookies, as Clerk's fallback would, shows the
    // guard itself refuses state changes without a bearer token.
    const harness = makeDeps({
      auth: {
        authenticate: async (request) =>
          request.headers.get("cookie") === "__session=valid"
            ? { userId: "user_1", email: "user_1@example.com", isAdmin: false }
            : null,
      },
    });

    const started = await startLink(harness);

    const response = await app.fetch(
      post("/api/link/approve", { userCode: started.userCode }, { cookie: "__session=valid" }),
      harness.deps,
    );

    expect(response.status).toBe(401);
    expect(await poll(harness, started.deviceCode)).toEqual({ status: "pending" });
  });

  it("rejects a text/plain approval", async () => {
    const harness = makeDeps();
    const started = await startLink(harness);

    const response = await app.fetch(
      new Request(`${BASE}/api/link/approve`, {
        method: "POST",
        headers: { "content-type": "text/plain", ...authHeader("user_1") },
        body: JSON.stringify({ userCode: started.userCode }),
      }),
      harness.deps,
    );

    expect(response.status).toBe(400);
    expect(await poll(harness, started.deviceCode)).toEqual({ status: "pending" });
  });

  it("treats unknown device codes as expired", async () => {
    const harness = makeDeps();
    expect(await poll(harness, "not-a-real-device-code")).toEqual({ status: "expired" });
  });
});
