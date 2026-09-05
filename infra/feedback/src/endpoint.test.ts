// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";

import {
  PRODUCT_FEEDBACK_BODY_MAX_BYTES,
  type ProductFeedbackSubmission,
} from "@t3tools/contracts";
import {
  coarseIpAddress,
  makeProductFeedbackEndpoint,
  type ProductFeedbackRepository,
  type StoredProductFeedback,
} from "./endpoint.ts";

const baseSubmission = (): ProductFeedbackSubmission => ({
  schemaVersion: 1,
  feedback: "The send button stays disabled.",
  installToken: "install_token_1234567890",
  website: "",
});

function makeRepository() {
  const rows: StoredProductFeedback[] = [];
  let forcedIpCount: number | null = null;
  const repository: ProductFeedbackRepository = {
    countByCoarseIpHashSince: async (hash, since) =>
      forcedIpCount ??
      rows.filter((row) => row.coarseIpHash === hash && row.receivedAt >= since).length,
    findLatestByInstallHash: async (hash) =>
      rows
        .filter((row) => row.installHash === hash)
        .toSorted((left, right) => right.receivedAt.localeCompare(left.receivedAt))[0] ?? null,
    tryInsert: async (row, constraints) => {
      if (
        rows.filter(
          (stored) =>
            stored.coarseIpHash === row.coarseIpHash &&
            stored.receivedAt >= constraints.coarseIpSince,
        ).length >= constraints.coarseIpLimit
      ) {
        return "rate_limited";
      }
      if (
        rows.some(
          (stored) =>
            stored.coarseIpHash === row.coarseIpHash &&
            stored.receivedAt >= constraints.coarseIpCooldownSince,
        )
      ) {
        return "cooldown";
      }
      if (
        rows.some(
          (stored) =>
            stored.installHash === row.installHash && stored.receivedAt >= constraints.installSince,
        )
      ) {
        return "cooldown";
      }
      if (
        rows.some(
          (stored) =>
            stored.coarseIpHash === row.coarseIpHash &&
            stored.contentHash === row.contentHash &&
            stored.receivedAt >= constraints.duplicateSince,
        )
      ) {
        return "duplicate";
      }
      rows.push(row);
      return "accepted";
    },
    deleteExpired: async (now) => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index]!.expiresAt <= now) rows.splice(index, 1);
      }
    },
  };
  return {
    repository,
    rows,
    setIpCount: (count: number) => {
      forcedIpCount = count;
    },
  };
}

function request(payload: unknown, headers?: HeadersInit): Request {
  return new Request("https://feedback.akeru.test/v1/feedback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.42",
      ...headers,
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function reason(response: Response): Promise<string> {
  return ((await response.json()) as { reason: string }).reason;
}

describe("product feedback endpoint", () => {
  it("stores a strict, privacy-bounded payload and returns a feedback id", async () => {
    const memory = makeRepository();
    const endpoint = makeProductFeedbackEndpoint({
      repository: memory.repository,
      hmacSecret: "test-secret-that-is-long-enough",
      randomId: () => "feedback-1",
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    const response = await endpoint(
      request({
        ...baseSubmission(),
        turnstileToken: "challenge-token",
        element: {
          selector: "button[data-feedback-target='send']",
          component: "ComposerSendButton",
          source: "ComposerSendButton",
          role: "button",
          label: "Send",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      feedbackId: "fb_feedback-1",
      receivedAt: "2026-08-30T12:00:00.000Z",
    });
    expect(memory.rows).toHaveLength(1);
    expect(memory.rows[0]).not.toHaveProperty("installToken");
    expect(memory.rows[0]?.submission).not.toHaveProperty("installToken");
    expect(memory.rows[0]?.submission).not.toHaveProperty("turnstileToken");
    expect(memory.rows[0]?.submission).not.toHaveProperty("website");
    expect(memory.rows[0]?.installHash).toMatch(/^[a-f0-9]{64}$/);
    expect(memory.rows[0]?.coarseIpHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects malformed JSON, excess fields, oversized bodies, and honeypots", async () => {
    const memory = makeRepository();
    const endpoint = makeProductFeedbackEndpoint({
      repository: memory.repository,
      hmacSecret: "test-secret-that-is-long-enough",
    });

    expect(await reason(await endpoint(request("{")))).toBe("malformed");
    expect(
      await reason(await endpoint(request({ ...baseSubmission(), conversation: "full" }))),
    ).toBe("malformed");
    expect(
      await reason(await endpoint(request({ ...baseSubmission(), website: "bot.example" }))),
    ).toBe("honeypot");
    const oversized = "x".repeat(PRODUCT_FEEDBACK_BODY_MAX_BYTES + 1);
    const oversizedResponse = await endpoint(request(oversized));
    expect(oversizedResponse.status).toBe(413);
    expect(await reason(oversizedResponse)).toBe("oversized");
  });

  it("enforces per-install cooldown and duplicate detection", async () => {
    const memory = makeRepository();
    let now = new Date("2026-08-30T12:00:00.000Z");
    const endpoint = makeProductFeedbackEndpoint({
      repository: memory.repository,
      hmacSecret: "test-secret-that-is-long-enough",
      now: () => now,
    });

    expect((await endpoint(request(baseSubmission()))).status).toBe(201);
    now = new Date("2026-08-30T12:00:10.000Z");
    expect(
      await reason(await endpoint(request({ ...baseSubmission(), feedback: "Another note" }))),
    ).toBe("cooldown");
    now = new Date("2026-08-30T12:00:31.000Z");
    expect(await reason(await endpoint(request(baseSubmission())))).toBe("duplicate");
  });

  it("blocks token rotation from bypassing network cooldown and duplicate detection", async () => {
    const memory = makeRepository();
    let now = new Date("2026-08-30T12:00:00.000Z");
    const endpoint = makeProductFeedbackEndpoint({
      repository: memory.repository,
      hmacSecret: "test-secret-that-is-long-enough",
      now: () => now,
    });

    expect((await endpoint(request(baseSubmission()))).status).toBe(201);
    now = new Date("2026-08-30T12:00:01.000Z");
    expect(
      await reason(
        await endpoint(
          request({
            ...baseSubmission(),
            feedback: "A different message.",
            installToken: "another_install_token_12345",
          }),
        ),
      ),
    ).toBe("cooldown");

    now = new Date("2026-08-30T12:00:06.000Z");
    expect(
      await reason(
        await endpoint(
          request({
            ...baseSubmission(),
            installToken: "another_install_token_12345",
          }),
        ),
      ),
    ).toBe("duplicate");
  });

  it("rate limits coarse networks and challenges only suspicious traffic", async () => {
    const memory = makeRepository();
    memory.setIpCount(5);
    const challenged = makeProductFeedbackEndpoint({
      repository: memory.repository,
      hmacSecret: "test-secret-that-is-long-enough",
      turnstile: { siteKey: "site-key", verify: async (token) => token === "valid" },
    });
    const challengeResponse = await challenged(request(baseSubmission()));
    const challengeBody = await challengeResponse.json();
    expect(challengeBody).toMatchObject({ challengeSiteKey: "site-key" });
    expect(challengeBody).toMatchObject({ reason: "challenge_required" });

    expect(
      await reason(await challenged(request({ ...baseSubmission(), turnstileToken: "invalid" }))),
    ).toBe("challenge_failed");
    expect(
      (await challenged(request({ ...baseSubmission(), turnstileToken: "valid" }))).status,
    ).toBe(201);

    const limitedMemory = makeRepository();
    limitedMemory.setIpCount(20);
    const limited = makeProductFeedbackEndpoint({
      repository: limitedMemory.repository,
      hmacSecret: "test-secret-that-is-long-enough",
    });
    expect(await reason(await limited(request(baseSubmission())))).toBe("rate_limited");

    // Without Turnstile the suspicious threshold is the hard network limit.
    const noChallengeMemory = makeRepository();
    noChallengeMemory.setIpCount(4);
    const noChallenge = makeProductFeedbackEndpoint({
      repository: noChallengeMemory.repository,
      hmacSecret: "test-secret-that-is-long-enough",
    });
    expect((await noChallenge(request(baseSubmission()))).status).toBe(201);
    noChallengeMemory.setIpCount(5);
    const closed = await noChallenge(request(baseSubmission()));
    expect(closed.status).toBe(429);
    expect(closed.headers.get("retry-after")).toBe("3600");
    expect(await closed.json()).toMatchObject({ reason: "rate_limited" });
  });

  it("turns repository failures into a bounded honest response", async () => {
    const memory = makeRepository();
    const endpoint = makeProductFeedbackEndpoint({
      repository: {
        ...memory.repository,
        countByCoarseIpHashSince: async () => {
          throw new Error("database url and secret must not escape");
        },
      },
      hmacSecret: "test-secret-that-is-long-enough",
    });
    const response = await endpoint(request(baseSubmission()));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("database url");
    expect(body).not.toContain("secret");
  });

  it("accepts only one of two concurrent matching submissions", async () => {
    const memory = makeRepository();
    const endpoint = makeProductFeedbackEndpoint({
      repository: memory.repository,
      hmacSecret: "test-secret-that-is-long-enough",
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    const responses = await Promise.all([
      endpoint(request(baseSubmission())),
      endpoint(request(baseSubmission())),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(memory.rows).toHaveLength(1);
  });
});

describe("coarseIpAddress", () => {
  it("normalizes IPv4, mapped IPv4, and compressed IPv6", () => {
    expect(coarseIpAddress("203.0.113.99")).toBe("203.0.113.0/24");
    expect(coarseIpAddress("::ffff:203.0.113.99")).toBe("203.0.113.0/24");
    expect(coarseIpAddress("2001:db8:abcd:1234::99")).toBe("2001:0db8:abcd:1234::/64");
  });
});
