import {
  AuthAccessWriteScope,
  type AuthSessionState,
  type ChannelBinding,
  type ChannelProvider,
} from "@t3tools/contracts";

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
