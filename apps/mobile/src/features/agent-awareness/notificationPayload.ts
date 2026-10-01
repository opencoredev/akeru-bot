import { flow, Option, Predicate, Schema } from "effect";

const decodeNotificationResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    notification: Schema.Struct({
      request: Schema.Struct({
        identifier: Schema.optional(Schema.Unknown),
        content: Schema.optional(Schema.Unknown),
      }),
    }),
  }),
);

const decodeNotificationContent = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Struct({
      deepLink: Schema.optional(Schema.Unknown),
      environmentId: Schema.optional(Schema.Unknown),
      threadId: Schema.optional(Schema.Unknown),
    }),
  }),
);

type NotificationResponse = typeof decodeNotificationResponse extends (
  value: infer _Input,
) => Option.Option<infer Response>
  ? Response
  : never;

function dataFromNotificationResponse(response: NotificationResponse | null) {
  if (response === null) return null;

  const content = Option.getOrNull(
    decodeNotificationContent(response.notification.request.content),
  );

  return content?.data ?? null;
}

function identifierFromNotificationResponse(response: NotificationResponse | null): string | null {
  const identifier = response?.notification.request.identifier;

  return Predicate.isString(identifier) ? identifier : null;
}

function encodeThreadDeepLink(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): string | null {
  if (input.environmentId.length === 0 || input.threadId.length === 0) {
    return null;
  }

  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

function normalizeThreadDeepLink(value: string): string | null {
  if (
    value.trim() !== value ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  const parts = value.split("/");

  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "threads") {
    return null;
  }

  try {
    return encodeThreadDeepLink({
      environmentId: decodeURIComponent(parts[2] ?? ""),
      threadId: decodeURIComponent(parts[3] ?? ""),
    });
  } catch {
    return null;
  }
}

function deepLinkFromResponse(response: NotificationResponse | null): string | null {
  const data = dataFromNotificationResponse(response);
  const deepLink = data?.deepLink;

  if (Predicate.isString(deepLink)) {
    const normalizedDeepLink = normalizeThreadDeepLink(deepLink);

    if (normalizedDeepLink) {
      return normalizedDeepLink;
    }
  }

  const environmentId = data?.environmentId;
  const threadId = data?.threadId;

  if (Predicate.isString(environmentId) && Predicate.isString(threadId)) {
    return encodeThreadDeepLink({ environmentId, threadId });
  }

  return null;
}

export const extractAgentNotificationDeepLink = flow(
  decodeNotificationResponse,
  Option.getOrNull,
  deepLinkFromResponse,
);

export function routeAgentNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (deepLink: string) => void;
}): void {
  const response = Option.getOrNull(decodeNotificationResponse(input.response));
  const responseId = identifierFromNotificationResponse(response);

  if (responseId && input.handledResponseIds.has(responseId)) {
    return;
  }

  if (responseId) {
    input.handledResponseIds.add(responseId);
  }

  const deepLink = deepLinkFromResponse(response);

  if (deepLink) {
    input.navigate(deepLink);
  }
}
