import {
  AuthSessionId,
  AuthEnvironmentScopes,
  type AuthClientMetadata,
  type AuthClientSession,
} from "@akeru/contracts";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

export const SIGNING_SECRET_NAME = "server-signing-key";

export const DEFAULT_SESSION_TTL = Duration.days(30);

export const DEFAULT_WEBSOCKET_TOKEN_TTL = Duration.minutes(5);

export const SessionClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: Schema.Literals(["browser-session-cookie", "bearer-access-token"]),
  iat: Schema.Number,
  exp: Schema.Number,
});

export type SessionClaims = typeof SessionClaims.Type;

export const WebSocketClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("websocket"),
  sid: AuthSessionId,
  iat: Schema.Number,
  exp: Schema.Number,
});

export type WebSocketClaims = typeof WebSocketClaims.Type;

export const decodeSessionClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionClaims));

export const decodeWebSocketClaims = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WebSocketClaims),
);

export function createDefaultClientMetadata(): AuthClientMetadata {
  return {
    deviceType: "unknown",
  };
}

export function toClientMetadata(record: {
  readonly label: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceType: AuthClientMetadata["deviceType"];
  readonly os: string | null;
  readonly browser: string | null;
}): AuthClientMetadata {
  return {
    ...(record.label ? { label: record.label } : {}),
    ...(record.ipAddress ? { ipAddress: record.ipAddress } : {}),
    ...(record.userAgent ? { userAgent: record.userAgent } : {}),
    deviceType: record.deviceType,
    ...(record.os ? { os: record.os } : {}),
    ...(record.browser ? { browser: record.browser } : {}),
  };
}

export function toAuthClientSession(input: Omit<AuthClientSession, "current">): AuthClientSession {
  return {
    ...input,
    current: false,
  };
}
