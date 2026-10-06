/**
 * Server-side product analytics, keyed by Clerk user id. Events carry counts and
 * provider names only: never message content, tokens, or the anonymous usage id
 * an environment sends to its own analytics.
 */
export type CloudAnalyticsEvent =
  | "signed_up"
  | "environment_linked"
  | "environment_revoked"
  | "hosted_channel_route_created"
  | "hosted_channel_route_deleted";

export interface Analytics {
  readonly capture: (
    event: CloudAnalyticsEvent,
    userId: string,
    properties?: Record<string, string | number | boolean>,
  ) => void;
}

export const noopAnalytics: Analytics = { capture: () => {} };

export function createPostHogAnalytics(options: {
  readonly key: string;
  readonly host: string;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly fetch?: typeof fetch;
}): Analytics {
  if (!options.key) return noopAnalytics;
  const send = options.fetch ?? fetch;
  const endpoint = `${options.host.replace(/\/+$/, "")}/capture/`;

  return {
    capture: (event, userId, properties = {}) => {
      options.waitUntil(
        send(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: options.key,
            event,
            distinct_id: userId,
            properties: { ...properties, source: "akeru-cloud" },
            timestamp: new Date().toISOString(),
          }),
        }).catch(() => undefined),
      );
    },
  };
}
