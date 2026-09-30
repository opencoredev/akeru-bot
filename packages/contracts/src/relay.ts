import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Version negotiated by a relay and its attached environment. */
export const RelayProtocolVersion = Schema.Literal("1");
export type RelayProtocolVersion = typeof RelayProtocolVersion.Type;

/** Stable names that bind one relay route to one Akeru environment. */
export const RelayRouteBinding = Schema.Struct({
  protocolVersion: RelayProtocolVersion,
  routeId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
});
export type RelayRouteBinding = typeof RelayRouteBinding.Type;

/**
 * The enrollment secret only authorizes attachment of a route. It is not a
 * pairing credential or an established environment session token.
 */
export const RelayAttachRequest = Schema.Struct({
  binding: RelayRouteBinding,
  enrollmentSecret: TrimmedNonEmptyString,
});
export type RelayAttachRequest = typeof RelayAttachRequest.Type;

export const RelayAttachAccepted = Schema.Struct({
  binding: RelayRouteBinding,
  accepted: Schema.Literal(true),
});
export type RelayAttachAccepted = typeof RelayAttachAccepted.Type;
