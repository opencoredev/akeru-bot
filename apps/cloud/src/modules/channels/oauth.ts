import type { CloudOAuthPurpose, CloudOAuthResult, CloudServerMessage } from "@akeru/contracts";

import { oauthCallbackUrl, type CloudConfig } from "../../config.ts";
import type { CloudDeps, CloudHono } from "../../deps.ts";
import { randomId, randomToken, sha256Hex } from "../../lib/crypto.ts";
import { resultPage } from "../../lib/page.ts";
import { openOAuthResult, sealOAuthResult } from "./oauthResult.ts";
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
  readonly completion_ciphertext: string | null;
  readonly processing_until: string | null;
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

    const stateHash = await sha256Hex(state);

    const flow = await c.env.db
      .prepare("SELECT * FROM oauth_flows WHERE state_hash = ?")
      .bind(stateHash)
      .first<OAuthFlowRow>();

    if (!flow || flow.expires_at <= c.env.now().toISOString()) {
      return resultPage(400, "Link expired", "Start again from Akeru Bot.");
    }

    const active = await c.env.db
      .prepare(`SELECT 1 FROM environments e JOIN users u ON u.clerk_user_id = e.user_id
      WHERE e.id = ? AND e.revoked_at IS NULL AND u.disabled = 0`)
      .bind(flow.environment_id)
      .first();

    if (!active) return resultPage(410, "Link revoked", "Start again from Akeru Bot.");
    const hub = c.env.hubs.get(flow.environment_id);

    if (!(await hub.isOnline())) return resultPage(503, "Akeru Bot is offline", OFFLINE_MESSAGE);

    // Serialize callbacks with a short lease, including delivery of a cached result.
    const claimed = await c.env.db
      .prepare(`UPDATE oauth_flows SET processing_until = ?
      WHERE state_hash = ? AND expires_at > ? AND (processing_until IS NULL OR processing_until <= ?)
      RETURNING *`)
      .bind(
        new Date(c.env.now().getTime() + 60_000).toISOString(),
        stateHash,
        c.env.now().toISOString(),
        c.env.now().toISOString(),
      )
      .first<OAuthFlowRow>();

    if (!claimed) return resultPage(409, "Link in progress", "Try this page again shortly.");
    let result: CloudOAuthResult;

    try {
      const code = c.req.query("code");
      const providerError = c.req.query("error");
      result = claimed.completion_ciphertext
        ? await openOAuthResult(state, claimed.completion_ciphertext)
        : providerError || !code
          ? { purpose: flow.purpose, error: (providerError ?? "missing_code").slice(0, 128) }
          : await oauthPurposes[flow.purpose].complete({
              deps: c.env,
              code,
              redirectUri: oauthCallbackUrl(c.env.config),
              routeId: flow.route_id,
            });

      if (!claimed.completion_ciphertext) {
        await c.env.db
          .prepare("UPDATE oauth_flows SET completion_ciphertext = ? WHERE state_hash = ?")
          .bind(await sealOAuthResult(state, result), stateHash)
          .run();
      }

      const message: CloudServerMessage = { kind: "oauth.completed", flowId: flow.flow_id, result };

      if (!(await hub.deliver(message)))
        return resultPage(503, "Akeru Bot is offline", OFFLINE_MESSAGE);
      await c.env.db.prepare("DELETE FROM oauth_flows WHERE state_hash = ?").bind(stateHash).run();
    } finally {
      await c.env.db
        .prepare("UPDATE oauth_flows SET processing_until = NULL WHERE state_hash = ?")
        .bind(stateHash)
        .run();
    }

    if ("error" in result) {
      return resultPage(200, "Not connected", "Nothing changed. You can close this tab.");
    }

    return resultPage(200, "Connected", "Akeru Bot has what it needs. You can close this tab.");
  });
}
