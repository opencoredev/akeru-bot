import { describe, expect, it } from "vite-plus/test";
import { makeDeps, seedEnvironment } from "../test/fakes.ts";
import { runMaintenance } from "./maintenance.ts";

describe("disabled route retention", () => {
  it("prunes routes thirty days after disabling while retaining recent and active routes", async () => {
    const harness = makeDeps();
    seedEnvironment(harness.query, { routeId: "rt_active" });

    for (const { id, disabledAt } of [
      { id: "rt_expired", disabledAt: "2026-08-29T12:00:00.000Z" },
      { id: "rt_recent", disabledAt: "2026-09-28T12:00:00.000Z" },
    ]) {
      harness.query(
        `INSERT INTO channel_routes (route_id, provider, environment_id, user_id, label, created_at, disabled, disabled_at)
        VALUES (?, 'slack', 'env_1', 'user_1', 'Bot', '2026-08-01T00:00:00.000Z', 1, ?)`,
        id,
        disabledAt,
      );
    }

    await runMaintenance(harness.deps.db, harness.deps.now());
    expect(harness.query("SELECT route_id FROM channel_routes ORDER BY route_id")).toEqual([
      { route_id: "rt_active" },
      { route_id: "rt_recent" },
    ]);
  });
});
