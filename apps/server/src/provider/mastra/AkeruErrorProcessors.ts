import * as Predicate from "effect/Predicate";
import {
  isBadRequestError,
  PrefillErrorHandler,
  ProviderHistoryCompat,
  StreamErrorRetryProcessor,
} from "@mastra/core/processors";

export function isConnectionReset(cause: unknown): boolean {
  if (!cause) return false;
  const code = Predicate.isObjectOrArray(cause) && "code" in cause ? cause.code : undefined;

  if (Predicate.isString(code) && code.toUpperCase() === "ECONNRESET") return true;

  return cause instanceof Error && /econnreset|socket hang up/i.test(cause.message);
}

/**
 * The stream retry policy `createCodingAgent` applies by default. Akeru builds
 * its Agent directly because `createCodingAgent` also adds a task-list tool
 * whenever memory is on, and each list update costs a full model round trip.
 */
export function akeruErrorProcessors() {
  return [
    new StreamErrorRetryProcessor({
      retryUnknownErrors: true,
      maxRetries: 2,
      delayMs: 3_000,
      matchers: [
        { match: isBadRequestError, maxRetries: 1, delayMs: 2_000 },
        {
          match: isConnectionReset,
          maxRetries: 2,
          delayMs: ({ retryCount }) => Math.min(1_000 * 2 ** retryCount, 30_000),
        },
      ],
    }),
    new PrefillErrorHandler(),
    new ProviderHistoryCompat(),
  ];
}
