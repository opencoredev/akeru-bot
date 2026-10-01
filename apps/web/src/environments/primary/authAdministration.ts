import type {
  AuthClientMetadata,
  AuthEnvironmentScope,
  AuthPairingCredentialResult,
  ServerAuthSessionMethod,
  AuthSessionId,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { PrimaryEnvironmentHttpClient } from "./httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { PrimaryEnvironmentRequestError } from "./authErrors";

export interface ServerPairingLinkRecord {
  readonly id: string;
  readonly credential: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ServerClientSessionRecord {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}

export async function createServerPairingCredential(input?: {
  readonly label?: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
}): Promise<AuthPairingCredentialResult> {
  const trimmedLabel = input?.label?.trim();

  try {
    return await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.auth.pairingCredential({
            headers: {},
            payload: {
              ...(trimmedLabel ? { label: trimmedLabel } : {}),
              ...(input?.scopes ? { scopes: input.scopes } : {}),
            },
          }),
        ),
      ),
    );
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "create-pairing-credential",
      cause: error,
    });
  }
}

export async function listServerPairingLinks(): Promise<ReadonlyArray<ServerPairingLinkRecord>> {
  try {
    const pairingLinks = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.pairingLinks({ headers: {} })),
      ),
    );

    return pairingLinks.map((pairingLink) => {
      const timestamps = {
        createdAt: DateTime.formatIso(pairingLink.createdAt),
        expiresAt: DateTime.formatIso(pairingLink.expiresAt),
      };

      if (pairingLink.label === undefined) {
        return {
          id: pairingLink.id,
          credential: pairingLink.credential,
          scopes: pairingLink.scopes,
          subject: pairingLink.subject,
          createdAt: timestamps.createdAt,
          expiresAt: timestamps.expiresAt,
        };
      }

      return {
        id: pairingLink.id,
        credential: pairingLink.credential,
        scopes: pairingLink.scopes,
        subject: pairingLink.subject,
        label: pairingLink.label,
        createdAt: timestamps.createdAt,
        expiresAt: timestamps.expiresAt,
      };
    });
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "list-pairing-links",
      cause: error,
    });
  }
}

export async function revokeServerPairingLink(id: string): Promise<void> {
  try {
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.revokePairingLink({ headers: {}, payload: { id } })),
      ),
    );
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "revoke-pairing-link",
      pairingLinkId: id,
      cause: error,
    });
  }
}

export async function listServerClientSessions(): Promise<
  ReadonlyArray<ServerClientSessionRecord>
> {
  try {
    const clientSessions = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.clients({ headers: {} })),
      ),
    );

    return clientSessions.map((clientSession) => ({
      sessionId: clientSession.sessionId,
      subject: clientSession.subject,
      scopes: clientSession.scopes,
      method: clientSession.method,
      client: clientSession.client,
      issuedAt: DateTime.formatIso(clientSession.issuedAt),
      expiresAt: DateTime.formatIso(clientSession.expiresAt),
      lastConnectedAt:
        clientSession.lastConnectedAt === null
          ? null
          : DateTime.formatIso(clientSession.lastConnectedAt),
      connected: clientSession.connected,
      current: clientSession.current,
    }));
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "list-client-sessions",
      cause: error,
    });
  }
}

export async function revokeServerClientSession(sessionId: AuthSessionId): Promise<void> {
  try {
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.auth.revokeClient({ headers: {}, payload: { sessionId } }),
        ),
      ),
    );
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "revoke-client-session",
      sessionId,
      cause: error,
    });
  }
}

export async function revokeOtherServerClientSessions(): Promise<number> {
  try {
    const result = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.revokeOtherClients({ headers: {} })),
      ),
    );

    return result.revokedCount;
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "revoke-other-client-sessions",
      cause: error,
    });
  }
}
