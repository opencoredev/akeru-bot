import { Predicate } from "effect";

function dataFromNotificationResponse(response: unknown): Record<string, unknown> | null {
  if (!Predicate.isObjectOrArray(response) || response === null) {
    return null;
  }

  const notification = (response as { readonly notification?: unknown }).notification;

  if (!Predicate.isObjectOrArray(notification) || notification === null) {
    return null;
  }

  const request = (notification as { readonly request?: unknown }).request;

  if (!Predicate.isObjectOrArray(request) || request === null) {
    return null;
  }

  const content = (request as { readonly content?: unknown }).content;

  if (!Predicate.isObjectOrArray(content) || content === null) {
    return null;
  }

  const data = (content as { readonly data?: unknown }).data;

  return Predicate.isObjectOrArray(data) && data !== null
    ? (data as Record<string, unknown>)
    : null;
}

function identifierFromNotificationResponse(response: unknown): string | null {
  if (!Predicate.isObjectOrArray(response) || response === null) {
    return null;
  }

  const notification = (response as { readonly notification?: unknown }).notification;

  if (!Predicate.isObjectOrArray(notification) || notification === null) {
    return null;
  }

  const request = (notification as { readonly request?: unknown }).request;

  if (!Predicate.isObjectOrArray(request) || request === null) {
    return null;
  }

  const identifier = (request as { readonly identifier?: unknown }).identifier;

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

export function extractAgentNotificationDeepLink(response: unknown): string | null {
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

export function routeAgentNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (deepLink: string) => void;
}): void {
  const responseId = identifierFromNotificationResponse(input.response);

  if (responseId && input.handledResponseIds.has(responseId)) {
    return;
  }

  if (responseId) {
    input.handledResponseIds.add(responseId);
  }

  const deepLink = extractAgentNotificationDeepLink(input.response);

  if (deepLink) {
    input.navigate(deepLink);
  }
}
