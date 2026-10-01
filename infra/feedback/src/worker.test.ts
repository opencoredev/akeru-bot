import { describe, expect, it, vi } from "vite-plus/test";

import type { FeedbackWorkerEnv } from "../alchemy.run.ts";
import worker, { makeGitHubIssueOutbox } from "./worker.ts";

const ENDPOINT = "https://akeru-feedback.leoisadev.workers.dev/v1/feedback";

function unexpectedDatabaseOperation(): never {
  throw new Error("Unexpected database fixture operation");
}

function databaseFixture(input: Pick<D1Database, "prepare">) {
  return {
    ...input,
    batch: unexpectedDatabaseOperation,
    exec: unexpectedDatabaseOperation,
    withSession: unexpectedDatabaseOperation,
    dump: unexpectedDatabaseOperation,
  } satisfies D1Database;
}

function databaseResult(changes: number) {
  return {
    success: true,
    results: [],
    meta: {
      changes,
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
    },
  } satisfies D1Result<never>;
}

function statementFixture(
  run: D1PreparedStatement["run"],
  first: D1PreparedStatement["first"] = unexpectedDatabaseOperation,
) {
  const statement = {
    bind: vi.fn((): D1PreparedStatement => statement),
    first,
    run,
    all: unexpectedDatabaseOperation,
    raw: unexpectedDatabaseOperation,
  } satisfies D1PreparedStatement;

  return statement;
}

function env(overrides: Partial<FeedbackWorkerEnv> = {}): FeedbackWorkerEnv {
  return {
    DB: databaseFixture({ prepare: unexpectedDatabaseOperation }),
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
  const statement = statementFixture(
    async () => databaseResult(1),
    async () => null,
  );

  return databaseFixture({ prepare: () => statement });
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
    const run = vi.fn(async () => databaseResult(0));
    const statement = statementFixture(run);
    const { bind } = statement;
    const prepare = vi.fn((_sql: string) => statement);

    await worker.scheduled(
      {} as ScheduledController,
      env({ DB: databaseFixture({ prepare }) }),
      {} as ExecutionContext,
    );

    expect(prepare).toHaveBeenCalledWith("DELETE FROM akeru_feedback_inbox WHERE expires_at <= ?");
    expect(bind).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(run).toHaveBeenCalledOnce();
  });

  it("claims only unexpired feedback submitted with public delivery enabled", async () => {
    const run = vi.fn(async () => databaseResult(0));
    const statement = statementFixture(run);
    const { bind } = statement;
    const prepare = vi.fn((_sql: string) => statement);
    const outbox = makeGitHubIssueOutbox(databaseFixture({ prepare }));

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
    const run = vi.fn(async () => databaseResult(1));
    const statement = statementFixture(run);
    const { bind } = statement;
    const prepare = vi.fn((_sql: string) => statement);
    const outbox = makeGitHubIssueOutbox(databaseFixture({ prepare }));

    await outbox.markDelivered("fb_example", "claim-example", 42, "https://example.com/42");

    expect(prepare.mock.calls[0]?.[0]).toContain("github_delivery_claim_id = ?");
    expect(bind).toHaveBeenCalledWith(42, "https://example.com/42", "fb_example", "claim-example");
  });
});
