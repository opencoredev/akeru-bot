import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import {
  ChannelFailureCategory as ChannelFailureCategorySchema,
  type ChannelFailureCategory,
  type ChannelProvider,
} from "@akeru/contracts";
import { Chat } from "chat";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Transport adapters must confirm that no part of the reply was accepted before using this error.
 * The category picks the repair clients offer; a rejection without one counts as credentials.
 */
export class ChannelPostRejectedError extends Schema.TaggedErrorClass<ChannelPostRejectedError>()(
  "ChannelPostRejectedError",
  { message: Schema.String, category: Schema.optional(ChannelFailureCategorySchema) },
) {}

/**
 * A channel operation failed. The message is safe to show and never carries provider errors.
 * The category, when known, tells clients which repair to offer.
 */
export class ChannelRuntimeError extends Schema.TaggedErrorClass<ChannelRuntimeError>()(
  "ChannelRuntimeError",
  { message: Schema.String, category: Schema.optional(ChannelFailureCategorySchema) },
) {}

export const failWith = (message: string, category?: ChannelFailureCategory) =>
  Effect.fail(new ChannelRuntimeError({ message, ...(category ? { category } : {}) }));

export const channelTransportErrorMessage = "Channel provider request failed.";

/**
 * A transport SDK promise rejected. The message is fixed because SDK errors can echo request
 * data; the cause keeps the original for classification and must never reach a client or log.
 */
export class ChannelTransportError extends Schema.TaggedErrorClass<ChannelTransportError>()(
  "ChannelTransportError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export const transportError = (cause: unknown) =>
  new ChannelTransportError({ message: channelTransportErrorMessage, cause });

/** Runs an SDK promise and keeps its original rejection as the cause. */
export const fromPromise = <A>(
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, ChannelTransportError> =>
  Effect.tryPromise({ try: () => evaluate(), catch: transportError });

export const networkErrorCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "NETWORK_ERROR",
]);

export const isNetworkFailure = (cause: unknown, depth = 0): boolean => {
  if (depth > 4 || !Predicate.isObjectOrArray(cause)) return false;
  const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;

  if (Predicate.isString(code) && networkErrorCodes.has(code)) {
    // Discord wraps API rejections in NETWORK_ERROR; an HTTP status means the request arrived.
    const original =
      Predicate.hasProperty(cause, "originalError") &&
      Predicate.isObjectOrArray(cause.originalError)
        ? cause.originalError
        : undefined;

    return !(
      original &&
      Predicate.hasProperty(original, "status") &&
      Predicate.isNumber(original.status)
    );
  }

  if (cause instanceof TypeError && cause.message === "fetch failed") return true;

  if (cause instanceof DOMException && cause.name === "TimeoutError") return true;

  return isNetworkFailure(
    Predicate.hasProperty(cause, "cause") ? cause.cause : undefined,
    depth + 1,
  );
};

export const isChannelRuntimeError = Schema.is(ChannelRuntimeError);

/** True for a definite provider rejection: no part of the reply reached the channel. */
export const isChannelPostRejected = Schema.is(ChannelPostRejectedError);

export const isChannelTransportError = Schema.is(ChannelTransportError);

/** Classifies a failed channel operation. Unknown provider rejections count as credentials. */
export const channelFailureCategory = (cause: unknown): ChannelFailureCategory => {
  if (isChannelRuntimeError(cause) || isChannelPostRejected(cause))
    return cause.category ?? "credentials";

  if (isChannelTransportError(cause))
    return isNetworkFailure(cause.cause) ? "network" : "credentials";

  return "credentials";
};

export const channelFailureMessages: Record<ChannelFailureCategory, string> = {
  credentials: "The channel provider rejected the connection. Check the channel credentials.",
  network: "Could not reach the channel provider. Check the network and try again.",
  project: "The channel project is unavailable. Choose another project.",
  "delivery-unknown":
    "This channel reply has an unfinished delivery attempt. Check the channel before sending another reply.",
  restore: "Connection restore failed. Reconnect with updated credentials.",
};

/** The fixed, client-safe text for a failure category. */
export const channelFailureMessage = (category: ChannelFailureCategory) =>
  channelFailureMessages[category];

export interface ChannelFailurePresentation {
  readonly message: string;
  /** Absent for internal failures such as storage errors, which have no channel repair. */
  readonly category?: ChannelFailureCategory;
}

export const channelCommandFailedMessage = "Channel command failed. Try again.";

/**
 * Turns any channel failure into text a client may see. Runtime errors carry fixed messages
 * written here; transport errors get a fixed message for their category; everything else is
 * internal. Provider error text never passes through.
 */
export const channelFailurePresentation = (cause: unknown): ChannelFailurePresentation => {
  if (isChannelRuntimeError(cause))
    return { message: cause.message, category: channelFailureCategory(cause) };

  if (isChannelTransportError(cause)) {
    const category = channelFailureCategory(cause);

    return { message: channelFailureMessage(category), category };
  }

  if (isChannelPostRejected(cause))
    return { message: channelDeliveryRejectedError, category: channelFailureCategory(cause) };

  return { message: channelCommandFailedMessage };
};

export const channelDeliveryUnknownError = channelFailureMessages["delivery-unknown"];

export const channelDeliveryRejectedError =
  "The channel rejected this reply. Correct the channel problem, then retry.";

export const isSlackPostRejection = Schema.is(
  Schema.Union([
    Schema.Struct({
      code: Schema.Literal("slack_webapi_platform_error"),
      data: Schema.Struct({
        ok: Schema.Literal(false),
        error: Schema.Literals([
          "channel_not_found",
          "not_in_channel",
          "is_archived",
          "missing_scope",
          "no_permission",
          "invalid_auth",
          "not_authed",
          "token_revoked",
          "account_inactive",
          "msg_too_long",
          "no_text",
          "restricted_action",
        ]),
      }),
    }),
    Schema.Struct({ code: Schema.Literal("slack_webapi_rate_limited_error") }),
    Schema.Struct({
      name: Schema.Literal("AdapterRateLimitError"),
      adapter: Schema.Literal("slack"),
      code: Schema.Literal("RATE_LIMITED"),
    }),
  ]),
);

export const isDiscordPostRejection = Schema.is(
  Schema.Struct({
    name: Schema.Literal("NetworkError"),
    adapter: Schema.Literal("discord"),
    code: Schema.Literal("NETWORK_ERROR"),
    originalError: Schema.Struct({
      name: Schema.Literal("DiscordApiError"),
      status: Schema.Literals([400, 401, 403, 404, 429]),
      code: Schema.Literals([10003, 10008, 50001, 50013, 50014, 50035, 20028, 20029]),
    }),
  }),
);

export const isTelegramPostRejection = Schema.is(
  Schema.Union([
    Schema.Struct({
      name: Schema.Literal("AuthenticationError"),
      adapter: Schema.Literal("telegram"),
      code: Schema.Literal("AUTH_FAILED"),
    }),
    Schema.Struct({
      name: Schema.Literal("PermissionError"),
      adapter: Schema.Literal("telegram"),
      code: Schema.Literal("PERMISSION_DENIED"),
      action: Schema.Literal("sendMessage"),
    }),
    Schema.Struct({
      name: Schema.Literal("ResourceNotFoundError"),
      adapter: Schema.Literal("telegram"),
      code: Schema.Literal("NOT_FOUND"),
      resourceType: Schema.Literal("sendMessage"),
    }),
    Schema.Struct({
      name: Schema.Literal("AdapterRateLimitError"),
      adapter: Schema.Literal("telegram"),
      code: Schema.Literal("RATE_LIMITED"),
    }),
  ]),
);

export const postChannelText = (
  chat: Chat,
  provider: ChannelProvider,
  threadId: string,
  text: string,
) =>
  Effect.tryPromise({
    try: () => chat.thread(threadId).post(text),
    // These classifiers cover text-only posts, not partial attachment batches.
    // Provider errors can contain credentials. Do not retain their messages or causes.
    catch: (cause) =>
      cause instanceof Error &&
      Match.value(provider).pipe(
        Match.when("slack", () => isSlackPostRejection(cause)),
        Match.when("discord", () => isDiscordPostRejection(cause)),
        Match.when("telegram", () => isTelegramPostRejection(cause)),
        Match.orElse(() => false),
      )
        ? new ChannelPostRejectedError({ message: channelDeliveryRejectedError })
        : new ChannelRuntimeError({ message: channelDeliveryUnknownError }),
  }).pipe(Effect.asVoid);
