import { EnvironmentId } from "@akeru/contracts";
import { stripPairingTokenFromUrl } from "@akeru/shared/remote";
import { type EnvironmentConnectionPhase } from "@akeru/client-runtime/connection";

export interface SavedRemoteConnection {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly displayUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string | null;
}

export type RemoteClientConnectionState = EnvironmentConnectionPhase;

export function redactPairingCredential(pairingUrl: string): string {
  const trimmed = pairingUrl.trim();
  try {
    return stripPairingTokenFromUrl(new URL(trimmed)).toString();
  } catch {
    return trimmed;
  }
}
