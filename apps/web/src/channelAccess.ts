import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import {
  AuthAccessWriteScope,
  type AuthSessionState,
  type ChannelBinding,
  ChannelFailureCategory,
  type ChannelProvider,
} from "@akeru/contracts";

export function canManageChannels(
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
): boolean {
  return session?.authenticated === true && session.scopes?.includes(AuthAccessWriteScope) === true;
}

export function resolveChannelSettingsAccess(input: {
  readonly isPending: boolean;
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
}): "pending" | "allowed" | "denied" {
  if (input.session === null && input.isPending) return "pending";
  return canManageChannels(input.session) ? "allowed" : "denied";
}

export function connectedChannelBinding(
  bindings: ReadonlyArray<ChannelBinding> | undefined,
  provider: ChannelProvider,
): ChannelBinding | undefined {
  return bindings?.find(
    (binding) => binding.provider === provider && binding.status === "connected",
  );
}

const CHANNEL_IDENTITY_CONFLICT =
  /^This channel connection is (?:already connected|attached) to another bot\.$/u;

/**
 * Whether a failed channel command was rejected because another bot already owns the provider
 * account. The server sends one of two fixed messages for this case, and only an exact match counts.
 */
export function isChannelIdentityConflict(result: {
  readonly cause?: Cause.Cause<unknown>;
}): boolean {
  if (!result.cause) return false;
  const error = Cause.squash(result.cause);
  const message =
    typeof error === "object" && error !== null && "message" in error ? error.message : error;
  return typeof message === "string" && CHANNEL_IDENTITY_CONFLICT.test(message);
}

const isChannelFailureCategory = Schema.is(ChannelFailureCategory);

/** Why a failed channel command failed, when the server sent a category for it. */
export function channelFailureCategoryOf(result: {
  readonly cause?: Cause.Cause<unknown>;
}): ChannelFailureCategory | undefined {
  if (!result.cause) return undefined;
  const error = Cause.squash(result.cause);
  const category =
    typeof error === "object" && error !== null && "channelFailureCategory" in error
      ? error.channelFailureCategory
      : undefined;
  return isChannelFailureCategory(category) ? category : undefined;
}
