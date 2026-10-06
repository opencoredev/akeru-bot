import { describe, expect, it, vi } from "vite-plus/test";

import { authHeader, makeDeps, seedEnvironment } from "../../../test/fakes.ts";
import { createApp } from "../../app.ts";
import { sha256Hex } from "../../lib/crypto.ts";

const app = createApp();

const CONNECT = "https://cloud.akeru.test/v1/environments/connect";

const connect = (token: string) =>
  new Request(CONNECT, { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });

describe("environment socket", () => {
  it("hands a valid token's upgrade to that environment's hub", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { tokenHash: await sha256Hex("good-token") });
    const response = await app.fetch(connect("good-token"), harness.deps);
    expect(await response.text()).toBe("upgraded");
    const forwarded = harness.hub("env_1").forwardedRequests[0]!;
    expect(forwarded.headers.get("x-akeru-environment-id")).toBe("env_1");
    expect(forwarded.headers.get("x-akeru-user-id")).toBe("user_1");
  });

  it("rejects unknown tokens, revoked environments, and plain requests", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { tokenHash: await sha256Hex("good-token") });
    expect((await app.fetch(connect("bad-token"), harness.deps)).status).toBe(401);
    expect((await app.fetch(new Request(CONNECT), harness.deps)).status).toBe(401);
    harness.query("UPDATE environments SET revoked_at = '2026-09-29T00:00:00.000Z'");
    expect((await app.fetch(connect("good-token"), harness.deps)).status).toBe(410);
  });

  it("reports authorization status to plain GET diagnostics", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { tokenHash: await sha256Hex("good-token") });

    const probe = (token: string) =>
      app.fetch(
        new Request(CONNECT, { headers: { authorization: `Bearer ${token}` } }),
        harness.deps,
      );

    expect((await probe("good-token")).status).toBe(426);
    expect((await probe("bad-token")).status).toBe(401);
    harness.query("UPDATE users SET disabled = 1");
    expect((await probe("good-token")).status).toBe(410);
    expect(harness.hub("env_1").forwardedRequests).toEqual([]);
  });

  it("lets the owner revoke an environment and disables its routes", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });

    const revoke = (userId: string) =>
      app.fetch(
        new Request("https://cloud.akeru.test/api/environments/env_1/revoke", {
          method: "POST",
          headers: authHeader(userId),
        }),
        harness.deps,
      );

    expect((await revoke("user_2")).status).toBe(404);
    expect((await revoke("user_1")).status).toBe(200);
    expect(harness.hub("env_1").revoked).toBe(true);
    expect(harness.query("SELECT disabled FROM channel_routes")).toEqual([{ disabled: 1 }]);
    expect(harness.captured).toContainEqual({ event: "environment_revoked", userId: "user_1" });
    const disabledAt = harness.deps.now().toISOString();
    expect(harness.query("SELECT disabled_at FROM channel_routes")).toEqual([
      { disabled_at: disabledAt },
    ]);
    harness.advance(86_400_000);
    expect((await revoke("user_1")).status).toBe(200);
    expect(harness.query("SELECT disabled_at FROM channel_routes")).toEqual([
      { disabled_at: disabledAt },
    ]);
  });
  it("rolls back partial revocation and retries cleanup atomically", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    harness.query(
      "CREATE TRIGGER fail_cleanup BEFORE UPDATE ON channel_routes BEGIN SELECT RAISE(FAIL, 'temporary failure'); END",
    );

    const revoke = () =>
      app.fetch(
        new Request("https://cloud.akeru.test/api/environments/env_1/revoke", {
          method: "POST",
          headers: authHeader("user_1"),
        }),
        harness.deps,
      );

    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await revoke()).status).toBe(500);
    expect(harness.query("SELECT revoked_at FROM environments")).toEqual([{ revoked_at: null }]);
    harness.query("DROP TRIGGER fail_cleanup");
    expect((await revoke()).status).toBe(200);
    expect(harness.hub("env_1").revoked).toBe(true);
    expect(harness.query("SELECT disabled FROM channel_routes")).toEqual([{ disabled: 1 }]);
    expect((await revoke()).status).toBe(200);
    vi.restoreAllMocks();
  });
});
