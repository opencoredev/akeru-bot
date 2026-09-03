import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ComposioConnectionStatus = Schema.Literals([
  "INITIALIZING",
  "INITIATED",
  "ACTIVE",
  "FAILED",
  "EXPIRED",
  "INACTIVE",
  "REVOKED",
]);
export type ComposioConnectionStatus = typeof ComposioConnectionStatus.Type;

export const ComposioConnection = Schema.Struct({
  id: TrimmedNonEmptyString,
  toolkitSlug: TrimmedNonEmptyString,
  status: ComposioConnectionStatus,
  alias: Schema.optional(TrimmedNonEmptyString),
});
export type ComposioConnection = typeof ComposioConnection.Type;

export const ComposioStatus = Schema.Struct({
  configured: Schema.Boolean,
  connections: Schema.Array(ComposioConnection),
});
export type ComposioStatus = typeof ComposioStatus.Type;

export const ComposioToolkit = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  logoUrl: Schema.optional(TrimmedNonEmptyString),
  categories: Schema.Array(TrimmedNonEmptyString),
  toolsCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ComposioToolkit = typeof ComposioToolkit.Type;

export const ComposioToolkitSearchInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type ComposioToolkitSearchInput = typeof ComposioToolkitSearchInput.Type;

export const ComposioConfigureInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString,
});
export type ComposioConfigureInput = typeof ComposioConfigureInput.Type;

export const ComposioAuthorizeInput = Schema.Struct({
  toolkitSlug: TrimmedNonEmptyString,
  alias: Schema.optional(TrimmedNonEmptyString),
});
export type ComposioAuthorizeInput = typeof ComposioAuthorizeInput.Type;

export const ComposioAuthorizeResult = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  redirectUrl: TrimmedNonEmptyString,
});
export type ComposioAuthorizeResult = typeof ComposioAuthorizeResult.Type;

export const ComposioDisconnectInput = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
});
export type ComposioDisconnectInput = typeof ComposioDisconnectInput.Type;

export class ComposioOperationError extends Schema.TaggedErrorClass<ComposioOperationError>()(
  "ComposioOperationError",
  {
    operation: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  },
) {}
