import { describe, expect, it, vi } from "vite-plus/test";

import type { FeedbackWorkerEnv } from "../alchemy.run.ts";
import worker from "./worker.ts";

function env(overrides: Partial<FeedbackWorkerEnv> = {}): FeedbackWorkerEnv {
  return {
    DB: { prepare: vi.fn() } as unknown as D1Database,
    HMAC_SECRET: "test-secret-that-is-at-least-32-bytes",
    TURNSTILE_SITE_KEY: "",
    TURNSTILE_SECRET_KEY: "",
    ...overrides,
  } as FeedbackWorkerEnv;
}

describe("feedback worker", () => {
  it("stays disabled when the HMAC secret is too short", async () => {
    const response = await worker.fetch(
      new Request("https://feedback.akeru.bot/v1/feedback", { method: "POST" }),
      env({ HMAC_SECRET: "short" }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "disabled" });
  });

  it("stays disabled until Turnstile is configured", async () => {
    const response = await worker.fetch(
      new Request("https://feedback.akeru.bot/v1/feedback", { method: "POST" }),
      env(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: "disabled" });
  });

  it("deletes expired rows during the daily scheduled run", async () => {
    const run = vi.fn(async () => undefined);
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));

    await worker.scheduled(
      {} as ScheduledController,
      env({ DB: { prepare } as unknown as D1Database }),
      {} as ExecutionContext,
    );

    expect(prepare).toHaveBeenCalledWith("DELETE FROM akeru_feedback_inbox WHERE expires_at <= ?");
    expect(bind).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(run).toHaveBeenCalledOnce();
  });
});
