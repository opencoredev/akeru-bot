import type { CloudOAuthPurpose, CloudOAuthResult, CloudServerMessage } from "@akeru/contracts";

import { oauthCallbackUrl, type CloudConfig } from "../../config.ts";
import type { CloudDeps, CloudHono } from "../../deps.ts";
import { randomId, randomToken, sha256Hex } from "../../lib/crypto.ts";
import { resultPage } from "../../lib/page.ts";
import { oauthPurposes } from "./providers.ts";
import type { EnvironmentOwner, RequestOutcome } from "./routes.ts";

export const OAUTH_FLOW_TTL_MS = 10 * 60_000;

/** One OAuth purpose, such as installing a Slack app. */
export interface CloudOAuthPurposeHandler {
  readonly requiresRoute: boolean;
  /** Builds the authorize URL when the cloud owns the client id. */
  readonly begin: (input: {
    readonly config: CloudConfig;
    readonly state: string;
    readonly redirectUri: string;
  }) =>
    | { readonly ok: true; readonly authorizeUrl?: string }
    | { readonly ok: false; readonly message: string };
  /** Turns the provider's redirect into the result sent to the environment. */
  readonly complete: (input: {
    readonly deps: CloudDeps;
    readonly code: string;
    readonly redirectUri: string;
    readonly routeId: string | null;
  }) => Promise<CloudOAuthResult>;
}

interface OAuthFlowRow {
  readonly flow_id: string;
  readonly purpose: CloudOAuthPurpose;
  readonly environment_id: string;
  readonly route_id: string | null;
  readonly expires_at: string;
}

export async function beginOAuth(
  deps: Pick<CloudDeps, "db" | "config" | "now">,
  owner: EnvironmentOwner,
  purpose: CloudOAuthPurpose,
  routeId: string | undefined,
): Promise<RequestOutcome> {
  const handler = oauthPurposes[purpose];

  if (handler.requiresRoute) {
    if (!routeId) {
      return { ok: false, code: "invalid-request", message: "This purpose needs a routeId." };
    }

    const route = await deps.db
      .prepare("SELECT 1 FROM channel_routes WHERE route_id = ? AND environment_id = ?")
      .bind(routeId, owner.environmentId)
      .first();

    if (!route) return { ok: false, code: "not-found", message: "Unknown route." };
  }

  const state = randomToken();
  const redirectUri = oauthCallbackUrl(deps.config);
  const begun = handler.begin({ config: deps.config, state, redirectUri });

  if (!begun.ok) return { ok: false, code: "disabled", message: begun.message };
  const flowId = randomId("oa");
  await deps.db
    .prepare(
      `INSERT INTO oauth_flows (flow_id, state_hash, purpose, environment_id, route_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      flowId,
      await sha256Hex(state),
      purpose,
      owner.environmentId,
      handler.requiresRoute ? (routeId ?? null) : null,
      new Date(deps.now().getTime() + OAUTH_FLOW_TTL_MS).toISOString(),
    )
    .run();

  return {
    ok: true,
    value: {
      type: "oauth.begin",
      flowId,
      state,
      redirectUri,
      ...(begun.authorizeUrl ? { authorizeUrl: begun.authorizeUrl } : {}),
    },
  };
}

const OFFLINE_MESSAGE =
  "Akeru Bot on your computer isn't connected to Akeru Cloud right now. Open it, then try again.";

export function registerOAuthCallback(app: CloudHono) {
  app.get("/v1/oauth/callback", async (c) => {
    const state = c.req.query("state");

    if (!state) return resultPage(400, "Link incomplete", "Start again from Akeru Bot.");

    // Deleting the flow makes the state single-use.
    const flow = await c.env.db
      .prepare("DELETE FROM oauth_flows WHERE state_hash = ? RETURNING *")
      .bind(await sha256Hex(state))
      .first<OAuthFlowRow>();

    if (!flow || flow.expires_at <= c.env.now().toISOString()) {
      return resultPage(400, "Link expired", "Start again from Akeru Bot.");
    }

    const hub = c.env.hubs.get(flow.environment_id);

    if (!(await hub.isOnline())) return resultPage(503, "Akeru Bot is offline", OFFLINE_MESSAGE);

    const code = c.req.query("code");
    const providerError = c.req.query("error");

    const result: CloudOAuthResult =
      providerError || !code
        ? { purpose: flow.purpose, error: (providerError ?? "missing_code").slice(0, 128) }
        : await oauthPurposes[flow.purpose].complete({
            deps: c.env,
            code,
            redirectUri: oauthCallbackUrl(c.env.config),
            routeId: flow.route_id,
          });

    const message: CloudServerMessage = { kind: "oauth.completed", flowId: flow.flow_id, result };

    if (!(await hub.deliver(message))) {
      return resultPage(503, "Akeru Bot is offline", OFFLINE_MESSAGE);
    }

    if ("error" in result) {
      return resultPage(200, "Not connected", "Nothing changed. You can close this tab.");
    }

    return resultPage(200, "Connected", "Akeru Bot has what it needs. You can close this tab.");
  });
}
