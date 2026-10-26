import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { CloudEnvironmentMessage, CloudLinkPollResponse, CloudServerMessage } from "./cloud.ts";

const decodeEnvironmentMessage = Schema.decodeUnknownExit(CloudEnvironmentMessage);

const decodeServerMessage = Schema.decodeUnknownExit(CloudServerMessage);

const decodePollResponse = Schema.decodeUnknownExit(CloudLinkPollResponse);

describe("cloud socket protocol", () => {
  it("accepts a versioned hello and rejects unknown kinds", () => {
    expect(
      Exit.isSuccess(
        decodeEnvironmentMessage({
          kind: "hello",
          v: 1,
          serverVersion: "0.1.1",
          environmentName: "Studio Mac",
          capabilities: ["hosted-channels", "from-the-future"],
        }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decodeEnvironmentMessage({ kind: "hello", v: 2 }))).toBe(true);
    expect(Exit.isFailure(decodeEnvironmentMessage({ kind: "shell.exec" }))).toBe(true);
  });

  it("accepts an unlink request only with a request id", () => {
    expect(
      Exit.isSuccess(decodeEnvironmentMessage({ kind: "environment.unlink", requestId: "r1" })),
    ).toBe(true);
    expect(Exit.isFailure(decodeEnvironmentMessage({ kind: "environment.unlink" }))).toBe(true);
  });

  it("accepts account emails up to 320 characters", () => {
    const welcome = (email: string) =>
      decodeServerMessage({
        kind: "welcome",
        v: 1,
        environmentId: "env_1",
        account: { email },
        capabilities: [],
      });

    expect(Exit.isSuccess(welcome(`${"a".repeat(300)}@example.com`))).toBe(true);
    expect(Exit.isFailure(welcome(`${"a".repeat(320)}@example.com`))).toBe(true);
  });

  it("forwards raw channel requests with their route", () => {
    expect(
      Exit.isSuccess(
        decodeServerMessage({
          kind: "channel.inbound",
          routeId: "rt_abc123",
          provider: "slack",
          request: {
            method: "POST",
            path: "",
            headers: { "x-slack-signature": "v0=abc" },
            bodyBase64: "e30=",
            receivedAt: "2026-09-29T00:00:00.000Z",
          },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeServerMessage({
          kind: "channel.inbound",
          routeId: "../escape",
          provider: "slack",
          request: { method: "POST", path: "", headers: {}, bodyBase64: "", receivedAt: "x" },
        }),
      ),
    ).toBe(true);
  });

  it("carries the environment token only on approval", () => {
    expect(Exit.isSuccess(decodePollResponse({ status: "pending" }))).toBe(true);
    expect(Exit.isFailure(decodePollResponse({ status: "approved" }))).toBe(true);
  });
});
