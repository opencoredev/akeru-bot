// @effect-diagnostics globalDate:off
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";

import {
  createGitHubAppJwt,
  deliverFeedbackToGitHub,
  formatGitHubIssue,
  type FeedbackDeliveryOutbox,
  type FeedbackDeliveryRecord,
} from "./githubIssueDelivery.ts";

const record: FeedbackDeliveryRecord = {
  feedbackId: "fb_example",
  receivedAt: "2026-09-14T12:00:00.000Z",
  deliveryAttempts: 1,
  submission: {
    schemaVersion: 1,
    feedback: "The send button stays disabled.\nPlease fix it.",
    element: {
      selector: "button[data-feedback-target='send']",
      component: "ComposerSendButton",
      role: "button",
      label: "Send",
    },
  },
};

function outbox(overrides: Partial<FeedbackDeliveryOutbox> = {}): FeedbackDeliveryOutbox {
  return {
    claim: vi.fn(async () => record),
    listEligible: vi.fn(async () => []),
    markDelivered: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    markUnknown: vi.fn(async () => undefined),
    ...overrides,
  };
}

const destination = {
  repository: "opencoredev/akeru-bot",
  appId: "12345",
  installationId: "67890",
  privateKey: "private-key",
};
const signJwt = () => "app-jwt";
const installationTokenResponse = () => Response.json({ token: "installation-token" });

describe("GitHub feedback delivery", () => {
  it("formats a bounded maintainer-readable issue", () => {
    const issue = formatGitHubIssue(record);

    expect(issue.title).toBe("[Akeru feedback] The send button stays disabled. Please fix it.");
    expect(issue.body).toContain("    The send button stays disabled.");
    expect(issue.body).toContain("    Selector: button[data-feedback-target='send']");
    expect(issue.body).toContain("- Feedback ID: `fb_example`");
  });

  it("signs a short-lived RS256 GitHub App JWT", () => {
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2_048,
    });
    const jwt = createGitHubAppJwt(
      "12345",
      privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
      new Date("2026-09-14T12:00:00.000Z"),
    );
    const [header, payload, signature] = jwt.split(".");

    expect(JSON.parse(NodeBuffer.Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(NodeBuffer.Buffer.from(payload ?? "", "base64url").toString())).toEqual({
      iat: 1_789_387_140,
      exp: 1_789_387_740,
      iss: "12345",
    });
    expect(
      NodeCrypto.verify(
        "RSA-SHA256",
        NodeBuffer.Buffer.from(`${header}.${payload}`),
        publicKey,
        NodeBuffer.Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  it("creates and records a normal GitHub issue", async () => {
    const store = outbox();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(installationTokenResponse())
      .mockResolvedValueOnce(
        Response.json(
          { number: 42, html_url: "https://github.com/opencoredev/akeru-bot/issues/42" },
          { status: 201 },
        ),
      );

    await deliverFeedbackToGitHub({
      destination,
      feedbackId: record.feedbackId,
      outbox: store,
      request,
      signJwt,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/app/installations/67890/access_tokens",
    );
    expect(request.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/opencoredev/akeru-bot/issues",
    );
    expect(store.markDelivered).toHaveBeenCalledWith(
      "fb_example",
      42,
      "https://github.com/opencoredev/akeru-bot/issues/42",
    );
  });

  it("retries a confirmed GitHub rejection", async () => {
    const store = outbox();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(installationTokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    await deliverFeedbackToGitHub({
      destination,
      feedbackId: record.feedbackId,
      outbox: store,
      request,
      signJwt,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(store.markFailed).toHaveBeenCalledWith(
      "fb_example",
      "2026-09-14T12:05:00.000Z",
      "issue_http_503",
    );
    expect(store.markDelivered).not.toHaveBeenCalled();
  });

  it("flags an ambiguous issue-creation failure without retrying into a duplicate", async () => {
    const store = outbox();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(installationTokenResponse())
      .mockRejectedValueOnce(new Error("connection closed"));

    await deliverFeedbackToGitHub({
      destination,
      feedbackId: record.feedbackId,
      outbox: store,
      request,
      signJwt,
    });

    expect(store.markUnknown).toHaveBeenCalledWith("fb_example", "issue_network_error");
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it("retries when GitHub App authentication is unavailable", async () => {
    const store = outbox();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));

    await deliverFeedbackToGitHub({
      destination,
      feedbackId: record.feedbackId,
      outbox: store,
      request,
      signJwt,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
    });

    expect(store.markFailed).toHaveBeenCalledWith(
      "fb_example",
      "2026-09-14T12:05:00.000Z",
      "installation_token_http_503",
    );
    expect(store.markUnknown).not.toHaveBeenCalled();
  });
});
