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

export function connectedChannelBinding(
  bindings: ReadonlyArray<ChannelBinding> | undefined,
  provider: ChannelProvider,
): ChannelBinding | undefined {
  return bindings?.find(
    (binding) => binding.provider === provider && binding.status === "connected",
  );
}
