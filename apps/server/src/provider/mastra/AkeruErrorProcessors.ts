// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import {
  isBadRequestError,
  PrefillErrorHandler,
  ProviderHistoryCompat,
  StreamErrorRetryProcessor,
} from "@mastra/core/processors";

export function isConnectionReset(error: unknown): boolean {
  if (!error) return false;
  const code = typeof error === "object" && "code" in error ? error.code : undefined;

  if (typeof code === "string" && code.toUpperCase() === "ECONNRESET") return true;

  return error instanceof Error && /econnreset|socket hang up/i.test(error.message);
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
