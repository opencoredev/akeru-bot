import { describe, expect, it, vi } from "vite-plus/test";

import type { FeedbackWorkerEnv } from "../alchemy.run.ts";
import worker from "./worker.ts";

const ENDPOINT = "https://akeru-feedback.leoisadev.workers.dev/v1/feedback";

function env(overrides: Partial<FeedbackWorkerEnv> = {}): FeedbackWorkerEnv {
  return {
    DB: { prepare: vi.fn() } as unknown as D1Database,
    HMAC_SECRET: "test-secret-that-is-at-least-32-bytes",
    TURNSTILE_SITE_KEY: "",
    TURNSTILE_SECRET_KEY: "",
    ...overrides,
  } as FeedbackWorkerEnv;
}

// A D1 stub for one empty inbox: every lookup finds nothing and the insert lands.
function emptyInboxDatabase(): D1Database {
  const statement = {
    bind: () => statement,
    first: async () => null,
    run: async () => ({ meta: { changes: 1 } }),
  };
  return { prepare: () => statement } as unknown as D1Database;
}

function submission(): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.41" },
    body: JSON.stringify({
      schemaVersion: 1,
      feedback: "The send button stays disabled.",
      installToken: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      website: "",
    }),
  });
}

describe("feedback worker", () => {
  it("stays disabled when the HMAC secret is too short", async () => {
    const response = await worker.fetch(
      new Request(ENDPOINT, { method: "POST" }),
      env({ HMAC_SECRET: "short" }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({ reason: "disabled" });
  });

  it("accepts a direct browser submission without Turnstile keys", async () => {
    const response = await worker.fetch(submission(), env({ DB: emptyInboxDatabase() }));

    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({ feedbackId: expect.stringMatching(/^fb_/) });
  });

  it("answers CORS preflight before reading configuration", async () => {
    const response = await worker.fetch(
      new Request(ENDPOINT, { method: "OPTIONS" }),
      env({ HMAC_SECRET: "short" }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
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
