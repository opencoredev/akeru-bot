import { CloudChannelRouteId, type CloudOAuthResult } from "@akeru/contracts";
import * as Schema from "effect/Schema";

import { decodeOrNull } from "../../../lib/schema.ts";
import type { CloudOAuthPurposeHandler } from "../oauth.ts";
import type { HostedChannelProviderModule } from "../providers.ts";

const UrlVerification = Schema.Struct({
  type: Schema.Literal("url_verification"),
  challenge: Schema.String.check(Schema.isMaxLength(256)),
});

export const slackChannel: HostedChannelProviderModule = {
  // Retries are relayed like first deliveries, with `x-slack-retry-num`. The
  // environment's Slack adapter drops the ones it already handled by `event_id`.
  forwardsHeader: (name) => name === "content-type" || name.startsWith("x-slack-"),
  // Slack verifies the events URL while `apps.manifest.create` runs, before the
  // environment knows the new app id. Echoing the challenge needs no state.
  preflight: (body) => {
    if (!body.includes("url_verification")) return null;
    let parsed: unknown;

    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }

    const verification = decodeOrNull(UrlVerification, parsed);

    return verification ? Response.json({ challenge: verification.challenge }) : null;
  },
};

const SlackOAuthAccess = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    authed_user: Schema.Struct({
      id: Schema.String,
      access_token: Schema.String,
      refresh_token: Schema.optionalKey(Schema.String),
      expires_in: Schema.optionalKey(Schema.Number),
    }),
    team: Schema.Struct({ id: Schema.String, name: Schema.String }),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

export const slackOAuthPurposes = {
  // Akeru's manager app. The cloud owns its client secret, exchanges the code,
  // and hands the configuration token to the environment without storing it.
  "slack.manager": {
    requiresRoute: false,
    begin: ({ config, state, redirectUri }) => {
      if (!config.slackManager) return { ok: false, message: "Slack is not configured." };
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", config.slackManager.clientId);
      url.searchParams.set("user_scope", "app_configurations:write");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);

      return { ok: true, authorizeUrl: url.toString() };
    },
    complete: async ({ deps, code, redirectUri }): Promise<CloudOAuthResult> => {
      const manager = deps.config.slackManager;

      if (!manager) return { purpose: "slack.manager", error: "not_configured" };
      let body: unknown;

      try {
        const response = await deps.fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          body: new URLSearchParams({
            client_id: manager.clientId,
            client_secret: manager.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });

        body = await response.json();
      } catch {
        return { purpose: "slack.manager", error: "exchange_failed" };
      }

      const access = decodeOrNull(SlackOAuthAccess, body);

      if (!access) return { purpose: "slack.manager", error: "exchange_failed" };

      if (!access.ok) return { purpose: "slack.manager", error: access.error.slice(0, 128) };
      const { authed_user: user, team } = access;

      return {
        purpose: "slack.manager",
        accessToken: user.access_token,
        ...(user.refresh_token ? { refreshToken: user.refresh_token } : {}),
        ...(user.expires_in && user.expires_in > 0
          ? { expiresInSeconds: Math.floor(user.expires_in) }
          : {}),
        teamId: team.id,
        teamName: team.name,
        userId: user.id,
      };
    },
  },
  // A per-bot app. The environment owns its client secret, so the cloud only
  // relays the code back.
  "slack.install": {
    requiresRoute: true,
    begin: () => ({ ok: true }),
    complete: async ({ code, redirectUri, routeId }): Promise<CloudOAuthResult> =>
      routeId
        ? {
            purpose: "slack.install",
            routeId: CloudChannelRouteId.make(routeId),
            code,
            redirectUri,
          }
        : { purpose: "slack.install", error: "missing_route" },
  },
} satisfies Record<string, CloudOAuthPurposeHandler>;
