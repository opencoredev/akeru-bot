import type { CloudDatabase } from "../../database.ts";
import {
  CloudChannelRouteId,
  type CloudChannelRoute,
  type CloudErrorCode,
  type CloudHostedChannelProvider,
  type CloudRequestResult,
} from "@akeru/contracts";

import type { Analytics } from "../../analytics.ts";
import { oauthCallbackUrl, type CloudConfig } from "../../config.ts";
import { randomId } from "../../lib/crypto.ts";

export const ROUTES_PER_USER = 25;

/** The linked environment a socket request comes from. */
export interface EnvironmentOwner {
  readonly environmentId: string;
  readonly userId: string;
}

export type RequestOutcome =
  | { readonly ok: true; readonly value: CloudRequestResult }
  | { readonly ok: false; readonly code: CloudErrorCode; readonly message: string };

interface RouteServices {
  readonly db: CloudDatabase;
  readonly config: CloudConfig;
  readonly analytics: Analytics;
  readonly now: () => Date;
}

export function describeRoute(
  config: CloudConfig,
  routeId: string,
  provider: CloudHostedChannelProvider,
): CloudChannelRoute {
  return {
    routeId: CloudChannelRouteId.make(routeId),
    provider,
    inboundUrl: `${config.publicUrl}/v1/channels/${provider}/${routeId}`,
    oauthRedirectUrl: oauthCallbackUrl(config),
  };
}

const routeResult = (route: CloudChannelRoute): RequestOutcome => ({
  ok: true,
  value: { type: "channel.route", route },
});

const notFound: RequestOutcome = { ok: false, code: "not-found", message: "Unknown route." };

export async function createRoute(
  services: RouteServices,
  owner: EnvironmentOwner,
  provider: CloudHostedChannelProvider,
  label: string,
): Promise<RequestOutcome> {
  const routeId = randomId("rt");

  // The count check and insert run as one statement so parallel creates cannot pass the cap.
  const inserted = await services.db
    .prepare(
      `INSERT INTO channel_routes (route_id, provider, environment_id, user_id, label, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM channel_routes WHERE user_id = ?) < ?`,
    )
    .bind(
      routeId,
      provider,
      owner.environmentId,
      owner.userId,
      label,
      services.now().toISOString(),
      owner.userId,
      ROUTES_PER_USER,
    )
    .run();

  if (inserted.meta.changes !== 1) {
    return {
      ok: false,
      code: "limit-reached",
      message: `An account can have up to ${ROUTES_PER_USER} hosted bots.`,
    };
  }

  services.analytics.capture("hosted_channel_route_created", owner.userId, { provider });

  return routeResult(describeRoute(services.config, routeId, provider));
}

export async function updateRoute(
  services: RouteServices,
  owner: EnvironmentOwner,
  update: {
    readonly routeId: string;
    readonly label?: string;
    readonly externalAppId?: string;
    readonly externalWorkspaceId?: string;
    readonly externalWorkspaceName?: string;
  },
): Promise<RequestOutcome> {
  const row = await services.db
    .prepare(
      `UPDATE channel_routes SET
         label = COALESCE(?, label),
         external_app_id = COALESCE(?, external_app_id),
         external_workspace_id = COALESCE(?, external_workspace_id),
         external_workspace_name = COALESCE(?, external_workspace_name)
       WHERE route_id = ? AND environment_id = ?
       RETURNING provider`,
    )
    .bind(
      update.label ?? null,
      update.externalAppId ?? null,
      update.externalWorkspaceId ?? null,
      update.externalWorkspaceName ?? null,
      update.routeId,
      owner.environmentId,
    )
    .first<{ provider: CloudHostedChannelProvider }>();

  if (!row) return notFound;

  return routeResult(describeRoute(services.config, update.routeId, row.provider));
}

export async function deleteRoute(
  services: RouteServices,
  owner: EnvironmentOwner,
  routeId: string,
): Promise<RequestOutcome> {
  const row = await services.db
    .prepare(
      "DELETE FROM channel_routes WHERE route_id = ? AND environment_id = ? RETURNING provider",
    )
    .bind(routeId, owner.environmentId)
    .first<{ provider: string }>();

  if (!row) return notFound;
  await services.db.prepare("DELETE FROM oauth_flows WHERE route_id = ?").bind(routeId).run();
  services.analytics.capture("hosted_channel_route_deleted", owner.userId, {
    provider: row.provider,
  });

  return { ok: true, value: { type: "empty" } };
}
