import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";

import type { PreparedHttpAuthorization } from "../connection/model.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
}

/**
 * Primary/local environments with no bearer credential authenticate the
 * browser via a session cookie. A cross-origin `fetch` does not send cookies by
 * default, so those requests must opt into credentialed mode; bearer
 * connections carry their credential in a header and need no cookies. Applied
 * per-request via `FetchHttpClient.RequestInit`, which the fetch client reads
 * from the fiber context at request time.
 */
export const withEnvironmentCredentials = <A, E, R>(
  authorization: PreparedHttpAuthorization | null,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  authorization === null
    ? request.pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }))
    : request;

/**
 * Build the authorization headers for an authenticated environment HTTP
 * request, matching the credential the connection was prepared with:
 * - primary/local connections carry no credential,
 * - bearer connections send a static `Bearer` token,
 */
export const buildEnvironmentAuthHeaders = (
  authorization: PreparedHttpAuthorization | null,
): Effect.Effect<EnvironmentHttpAuthHeaders> =>
  Effect.succeed(authorization === null ? {} : { authorization: `Bearer ${authorization.token}` });
