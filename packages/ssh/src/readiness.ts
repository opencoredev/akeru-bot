import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { waitForHttpReady as waitForHttpReadyShared } from "@akeru/shared/httpReadiness";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";
import { SshHttpBridgeError, SshReadinessError } from "./errors.ts";
import { SSH_READY_PROBE_TIMEOUT_MS } from "./types.ts";

export const waitForHttpReady = (input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly path?: string;
}): Effect.Effect<void, SshReadinessError, HttpClient.HttpClient> =>
  waitForHttpReadyShared({
    baseUrl: input.baseUrl,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    probeTimeoutMs: input.probeTimeoutMs ?? SSH_READY_PROBE_TIMEOUT_MS,
    makeError: (failure) => {
      switch (failure.kind) {
        case "probe-timeout":
          return new SshReadinessError({
            message: `Backend readiness probe exceeded ${failure.probeTimeoutMs}ms at ${failure.requestUrl}.`,
            cause: failure.cause,
          });
        case "overall-timeout":
          return new SshReadinessError({
            message: `Timed out waiting ${failure.cause.timeoutMs}ms for backend readiness at ${failure.cause.baseUrl}.`,
            cause: failure.cause.lastFailure,
          });
        case "request-failure":
          return new SshReadinessError({
            message: `Backend readiness probe failed at ${failure.requestUrl}.`,
            cause: failure.cause,
          });
      }
    },
  });

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");

  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

const decodeHttpBaseUrl = Schema.decodeUnknownOption(Schema.String);

export const resolveLoopbackSshHttpBaseUrl = Effect.fn("ssh/tunnel.resolveLoopbackSshHttpBaseUrl")(
  function* (
    rawHttpBaseUrl: Parameters<typeof decodeHttpBaseUrl>[0],
  ): Effect.fn.Return<string, SshHttpBridgeError> {
    return yield* Effect.try({
      try: () => {
        const decoded = decodeHttpBaseUrl(rawHttpBaseUrl);

        if (Option.isNone(decoded) || decoded.value.trim().length === 0) {
          throw new Error("Invalid SSH forwarded http base URL.");
        }

        const baseUrl = new URL(decoded.value);

        if (!isLoopbackHostname(baseUrl.hostname)) {
          throw new Error("SSH desktop bridge only supports loopback forwarded URLs.");
        }

        return baseUrl.toString();
      },
      catch: (cause) =>
        new SshHttpBridgeError({
          message: cause instanceof Error ? cause.message : "Invalid SSH forwarded http base URL.",
          cause,
        }),
    });
  },
);
