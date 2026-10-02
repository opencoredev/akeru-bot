import {
  type AuthClientMetadata,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type ServerAuthSessionMethod,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";

export const DEFAULT_SESSION_SUBJECT = "cli-issued-session";

export const INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT = "administrative-bootstrap";

export function isEnvironmentHostSessionSubject(subject: string): boolean {
  return subject === INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT;
}

export interface IssuedPairingLink {
  readonly id: string;
  readonly credential: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export interface IssuedBearerSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: "bearer-access-token";
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.Utc;
}

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly expiresAt?: DateTime.DateTime;
}
