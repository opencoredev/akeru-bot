/**
 * Shared HTTP plumbing for subscription OAuth flows.
 *
 * Provider modules build their requests with `HttpClientRequest`, send them
 * through `sendOAuthRequest`, decode bodies with Schema, and bound each
 * operation with `withOAuthTimeout`. The Promise-returning provider exports
 * run through `runOAuthPromise`, which supplies the fetch-backed HttpClient.
 */

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";

/** The upstream request failed: transport error, timeout, or a non-2xx status. */
export class SubscriptionAuthRequestError extends Schema.TaggedErrorClass<SubscriptionAuthRequestError>()(
  "SubscriptionAuthRequestError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Transport failures, timeouts, 429, and 5xx responses may succeed on retry. */
  get retryable(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}

/** The upstream answered, but its body did not match the expected shape. */
export class SubscriptionAuthResponseError extends Schema.TaggedErrorClass<SubscriptionAuthResponseError>()(
  "SubscriptionAuthResponseError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** The caller supplied unusable login input (pasted code, state, device id). */
export class SubscriptionAuthInputError extends Schema.TaggedErrorClass<SubscriptionAuthInputError>()(
  "SubscriptionAuthInputError",
  { message: Schema.String },
) {}

export type SubscriptionAuthError =
  | SubscriptionAuthRequestError
  | SubscriptionAuthResponseError
  | SubscriptionAuthInputError;

/** Send one request; transport failures become `SubscriptionAuthRequestError`. */
export const sendOAuthRequest = Effect.fn("sendOAuthRequest")(function* (
  label: string,
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .execute(request)
    .pipe(
      Effect.mapError(
        (cause) =>
          new SubscriptionAuthRequestError({ message: `${label} failed: ${cause.message}`, cause }),
      ),
    );
});

/** Read a response body as text for error messages; never fails. */
export const responseText = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(Effect.orElseSucceed(() => ""));

/** Fail with the status and body text of a non-2xx response. */
export const failWithStatus = (label: string, response: HttpClientResponse.HttpClientResponse) =>
  Effect.flatMap(responseText(response), (text) =>
    Effect.fail(
      new SubscriptionAuthRequestError({
        message: `${label}: ${response.status}${text ? ` ${text}` : ""}`,
        status: response.status,
      }),
    ),
  );

const isOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;

/** Pass a 2xx response through; fail any other with its status and body text. */
export const ensureOk =
  (label: string) =>
  (
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, SubscriptionAuthRequestError> =>
    isOk(response) ? Effect.succeed(response) : failWithStatus(label, response);

/** Read a JSON body, or `undefined` when the body is not JSON. */
export const responseJson = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(Effect.orElseSucceed((): unknown => undefined));

/** Decode an already-read body, failing with `message` when the shape is wrong. */
export const decodeOAuthBody =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S, message: string) =>
  (body: unknown): Effect.Effect<S["Type"], SubscriptionAuthResponseError> =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError((cause) => new SubscriptionAuthResponseError({ message, cause })),
    );

/** Bound a whole upstream operation, reporting a timeout as a request error. */
export const withOAuthTimeout =
  (label: string, timeout: Duration.Input) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.timeoutOrElse(self, {
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new SubscriptionAuthRequestError({
            message: `${label} timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
          }),
        ),
    });

/**
 * Run a provider flow as a Promise with the fetch-backed HttpClient. Aborting
 * `signal` interrupts the flow. Failures reject with the tagged error, whose
 * `message` callers surface to the user.
 *
 * `fetch` is looked up on every run because the default `FetchHttpClient.Fetch`
 * reference captures the global once, which would pin whatever was installed first.
 */
export const runOAuthPromise = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  signal?: AbortSignal,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    ),
    signal !== undefined ? { signal } : undefined,
  );
