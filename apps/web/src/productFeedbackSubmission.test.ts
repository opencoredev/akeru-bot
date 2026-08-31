import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildProductFeedbackSubmission,
  readOrRotateProductFeedbackInstallToken,
  shouldRefreshProductFeedbackChallenge,
  submitProductFeedback,
} from "./productFeedbackSubmission";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("window", { location: { hostname: "localhost" } });
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
    userAgent: "Test OS",
    language: "en-US",
    onLine: true,
  });
});

describe("product feedback submission", () => {
  it("contains feedback but no user contact, excerpt, or conversation body", () => {
    const payload = buildProductFeedbackSubmission({
      draft: {
        feedback: "The action failed.",
        element: null,
      },
    });
    expect(payload).not.toHaveProperty("thread");
    expect(payload).not.toHaveProperty("conversation");
    expect(payload).not.toHaveProperty("category");
    expect(payload).not.toHaveProperty("responseExcerpt");
    expect(payload).not.toHaveProperty("contact");
  });

  it("keeps an installation token until a forced rotation", () => {
    const first = readOrRotateProductFeedbackInstallToken();
    expect(readOrRotateProductFeedbackInstallToken()).toBe(first);
    expect(readOrRotateProductFeedbackInstallToken(true)).not.toBe(first);
  });

  it("rotates malformed and future-dated installation tokens", () => {
    storage.set(
      "akeru.product-feedback.install-token.v1",
      JSON.stringify({ token: "broken", createdAt: Date.now() + 60_000 }),
    );
    expect(readOrRotateProductFeedbackInstallToken()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("continues when browser storage rejects the installation token", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage unavailable");
      },
    });
    expect(readOrRotateProductFeedbackInstallToken()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("returns an honest bounded failure when the endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("secret endpoint"))),
    );
    const result = await submitProductFeedback("https://feedback.example.test", {
      ...buildProductFeedbackSubmission({
        draft: {
          feedback: "Send failed.",
          element: null,
        },
      }),
    });
    expect(result).toEqual({
      ok: false,
      rejection: {
        reason: "internal",
        message: "Akeru could not send the feedback. Your draft is still available.",
      },
    });
  });

  it("refreshes a consumed verification challenge after a rejected submission", () => {
    const submission = {
      ...buildProductFeedbackSubmission({
        draft: { feedback: "Retry this.", element: null },
      }),
      turnstileToken: "consumed-token",
    };

    expect(
      shouldRefreshProductFeedbackChallenge(submission, {
        ok: false,
        rejection: { reason: "cooldown", message: "Try again." },
      }),
    ).toBe(true);
    expect(
      shouldRefreshProductFeedbackChallenge(submission, {
        ok: true,
        receipt: {
          feedbackId: "feedback-1",
          receivedAt: "2026-08-31T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });
});
