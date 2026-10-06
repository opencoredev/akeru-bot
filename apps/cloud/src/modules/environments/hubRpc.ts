import type {
  CloudForwardedRequest,
  CloudHostedChannelProvider,
  CloudServerMessage,
} from "@akeru/contracts";

/** Set by the Worker after it validates the environment token. The hub is not publicly reachable. */
export const ENVIRONMENT_ID_HEADER = "x-akeru-environment-id";

export const USER_ID_HEADER = "x-akeru-user-id";

export type InboundRelayOutcome = "delivered" | "offline" | "rate-limited";

/**
 * RPC surface of the `EnvironmentHub` Durable Object, one instance per
 * environment id. The Worker reaches it through `HubDirectory`.
 */
export interface EnvironmentHubRpc {
  /** Sends a message if the environment is connected. Returns whether it was sent. */
  deliver(message: CloudServerMessage): Promise<boolean>;
  /** Forwards a hosted channel request, or remembers it as missed while offline. */
  relayInbound(
    routeId: string,
    provider: CloudHostedChannelProvider,
    request: CloudForwardedRequest,
  ): Promise<InboundRelayOutcome>;
  isOnline(): Promise<boolean>;
  /** Tells the environment it was revoked and closes its socket. */
  revoke(): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

export interface HubDirectory {
  readonly get: (environmentId: string) => EnvironmentHubRpc;
}
