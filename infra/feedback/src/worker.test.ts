import { describe, expect, it, vi } from "vite-plus/test";

import type { FeedbackWorkerEnv } from "../alchemy.run.ts";
import worker, { makeGitHubIssueOutbox } from "./worker.ts";

const ENDPOINT = "https://akeru-feedback.leoisadev.workers.dev/v1/feedback";

function env(overrides: Partial<FeedbackWorkerEnv> = {}): FeedbackWorkerEnv {
  return {
    DB: { prepare: vi.fn() } as unknown as D1Database,
    HMAC_SECRET: "test-secret-that-is-at-least-32-bytes",
    TURNSTILE_SITE_KEY: "",
    TURNSTILE_SECRET_KEY: "",
    GITHUB_REPOSITORY: "",
    GITHUB_APP_ID: "",
    GITHUB_APP_INSTALLATION_ID: "",
    GITHUB_APP_PRIVATE_KEY: "",
    ...overrides,
  } as FeedbackWorkerEnv;
}

function context(waitUntil = vi.fn()): ExecutionContext {
  return {
    waitUntil,
    passThroughOnException: vi.fn(),
    props: {},
  };
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
      context(),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({ reason: "disabled" });
  });

  it("accepts a direct browser submission without Turnstile keys", async () => {
    const response = await worker.fetch(submission(), env({ DB: emptyInboxDatabase() }), context());

    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({ feedbackId: expect.stringMatching(/^fb_/) });
  });

  it("schedules GitHub issue delivery after accepting feedback", async () => {
    const waitUntil = vi.fn();
    const execution = context(waitUntil);

    const response = await worker.fetch(
      submission(),
      env({
        DB: emptyInboxDatabase(),
        GITHUB_REPOSITORY: "opencoredev/akeru-bot",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_INSTALLATION_ID: "67890",
        GITHUB_APP_PRIVATE_KEY: "invalid-test-key",
      }),
      execution,
    );

    expect(response.status).toBe(201);
    expect(waitUntil).toHaveBeenCalledOnce();
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
  });

  it("answers CORS preflight before reading configuration", async () => {
    const response = await worker.fetch(
      new Request(ENDPOINT, { method: "OPTIONS" }),
      env({ HMAC_SECRET: "short" }),
      context(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });

  it("deletes expired rows during the daily scheduled run", async () => {
    const run = vi.fn(async () => undefined);
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn((_sql: string) => ({ bind }));

    await worker.scheduled(
      {} as ScheduledController,
      env({ DB: { prepare } as unknown as D1Database }),
      {} as ExecutionContext,
    );

    expect(prepare).toHaveBeenCalledWith("DELETE FROM akeru_feedback_inbox WHERE expires_at <= ?");
    expect(bind).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(run).toHaveBeenCalledOnce();
  });

  it("claims only unexpired feedback submitted with public delivery enabled", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 0 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    const outbox = makeGitHubIssueOutbox({ prepare } as unknown as D1Database);

    await outbox.claim(
      "fb_example",
      "claim-example",
      "2026-09-14T12:00:00.000Z",
      "2026-09-14T12:01:00.000Z",
    );

    expect(prepare.mock.calls[0]?.[0]).toContain("github_delivery_eligible = 1");
    expect(prepare.mock.calls[0]?.[0]).toContain("expires_at > ?");
    expect(bind).toHaveBeenCalledWith(
      "claim-example",
      "2026-09-14T12:01:00.000Z",
      "fb_example",
      "2026-09-14T12:00:00.000Z",
      "2026-09-14T12:00:00.000Z",
      "2026-09-14T12:00:00.000Z",
    );
  });

  it("updates a delivery only for the invocation that owns the claim", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    const outbox = makeGitHubIssueOutbox({ prepare } as unknown as D1Database);

    await outbox.markDelivered("fb_example", "claim-example", 42, "https://example.com/42");

    expect(prepare.mock.calls[0]?.[0]).toContain("github_delivery_claim_id = ?");
    expect(bind).toHaveBeenCalledWith(42, "https://example.com/42", "fb_example", "claim-example");
  });
});
