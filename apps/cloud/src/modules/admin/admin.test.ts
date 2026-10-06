import { describe, expect, it } from "vite-plus/test";

import { authHeader, makeDeps, seedEnvironment } from "../../../test/fakes.ts";
import { createApp } from "../../app.ts";

const app = createApp();

const request = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://cloud.akeru.test${path}`, { headers });

describe("browser API", () => {
  it("gates the admin overview on the admin role", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_ada" });
    expect((await app.fetch(request("/api/admin/overview"), harness.deps)).status).toBe(401);
    expect(
      (await app.fetch(request("/api/admin/overview", authHeader("user_1")), harness.deps)).status,
    ).toBe(403);

    const response = await app.fetch(
      request("/api/admin/overview", authHeader("admin_1")),
      harness.deps,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      totals: { users: 2, environments: 1, routes: 1 },
      routes: [{ routeId: "rt_ada", email: "user_1@example.com", delivered: 0, dropped: 0 }],
    });
  });

  it("records a user once and reports their environments and routes", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { userId: "user_9", routeId: "rt_ada" });
    harness.hub("env_1").online = false;
    const response = await app.fetch(request("/api/me", authHeader("user_9")), harness.deps);
    expect(await response.json()).toMatchObject({
      account: { email: "user_9@example.com", isAdmin: false },
      environments: [{ id: "env_1", name: "Studio Mac", status: "offline" }],
      routes: [{ routeId: "rt_ada", provider: "slack", environmentId: "env_1" }],
    });
    const fresh = await app.fetch(request("/api/me", authHeader("user_new")), harness.deps);
    expect(fresh.status).toBe(200);
    await app.fetch(request("/api/me", authHeader("user_new")), harness.deps);
    expect(harness.captured.filter((entry) => entry.event === "signed_up")).toEqual([
      { event: "signed_up", userId: "user_new" },
    ]);
  });

  it("blocks disabled accounts", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query);
    harness.query("UPDATE users SET disabled = 1");
    const response = await app.fetch(request("/api/me", authHeader("user_1")), harness.deps);
    expect(response.status).toBe(403);
  });

  it("serves public config and health", async () => {
    const harness = makeDeps();
    expect(await (await app.fetch(request("/api/config"), harness.deps)).json()).toEqual({
      clerkPublishableKey: "pk_test_123",
    });
    expect((await app.fetch(request("/v1/health"), harness.deps)).status).toBe(200);
  });
});
