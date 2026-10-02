import * as Predicate from "effect/Predicate";
import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  type AuthAccessTokenResult,
  type AuthBrowserSessionResult,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthEnvironmentScope,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  type AuthSessionId,
  type AuthSessionState,
  type ServerAuthDescriptor,
  type AuthWebSocketTicketResult,
} from "@akeru/contracts";
import { encodeOAuthScope } from "@akeru/shared/oauthScope";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { hasPairedAdminClient } from "./adminClients.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { layerConfig as SqlitePersistenceLayer } from "../persistence/Layers/Sqlite.ts";
import {
  DEFAULT_SESSION_SUBJECT,
  INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
  type IssuedPairingLink,
  type IssuedBearerSession,
  type AuthenticatedSession,
} from "./EnvironmentAuthTypes.ts";
import {
  ServerAuthBootstrapCredentialValidationError,
  ServerAuthSessionCredentialValidationError,
  ServerAuthAuthenticatedSessionIssueError,
  ServerAuthAuthenticatedAccessTokenIssueError,
  ServerAuthPairingLinkCreationError,
  ServerAuthPairingLinksListError,
  ServerAuthPairingLinkRevocationError,
  ServerAuthSessionTokenIssueError,
  ServerAuthSessionsListError,
  ServerAuthSessionRevocationError,
  ServerAuthOtherSessionsRevocationError,
  ServerAuthWebSocketTokenIssueError,
  ServerAuthInternalError,
  ServerAuthMissingCredentialError,
  ServerAuthInvalidCredentialError,
  ServerAuthCredentialError,
  isServerAuthCredentialError,
  ServerAuthScopeNotGrantedError,
  ServerAuthInvalidRequestError,
  ServerAuthForbiddenOperationError,
} from "./EnvironmentAuthErrors.ts";

export class EnvironmentAuth extends Context.Service<
  EnvironmentAuth,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
    readonly getSessionState: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthSessionState, ServerAuthInternalError>;
    readonly createBrowserSession: (
      credential: string,
      requestMetadata: AuthClientMetadata,
    ) => Effect.Effect<
      {
        readonly response: AuthBrowserSessionResult;
        readonly sessionToken: string;
      },
      ServerAuthInvalidCredentialError | ServerAuthInternalError
    >;
    readonly exchangeBootstrapCredentialForAccessToken: (
      credential: string,
      requestedScopes: ReadonlyArray<AuthEnvironmentScope> | undefined,
      requestMetadata: AuthClientMetadata,
    ) => Effect.Effect<
      AuthAccessTokenResult,
      ServerAuthInvalidCredentialError | ServerAuthInvalidRequestError | ServerAuthInternalError
    >;
    readonly createPairingLink: (input?: {
      readonly ttl?: Duration.Duration;
      readonly label?: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly subject?: string;
      readonly purpose?: "startup";
    }) => Effect.Effect<IssuedPairingLink, ServerAuthInternalError>;
    readonly issuePairingCredential: (
      input?: AuthCreatePairingCredentialInput,
    ) => Effect.Effect<AuthPairingCredentialResult, ServerAuthInternalError>;
    readonly issueStartupPairingCredential: () => Effect.Effect<
      AuthPairingCredentialResult,
      ServerAuthInternalError
    >;
    readonly listPairingLinks: (input?: {
      readonly excludeSubjects?: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<AuthPairingLink>, ServerAuthInternalError>;
    readonly revokePairingLink: (id: string) => Effect.Effect<boolean, ServerAuthInternalError>;
    readonly issueSession: (input?: {
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly label?: string;
    }) => Effect.Effect<IssuedBearerSession, ServerAuthInternalError>;
    readonly listSessions: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      ServerAuthInternalError
    >;
    readonly revokeSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ServerAuthInternalError>;
    readonly revokeOtherSessionsExcept: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<number, ServerAuthInternalError>;
    readonly listClientSessions: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<ReadonlyArray<AuthClientSession>, ServerAuthInternalError>;
    readonly revokeClientSession: (
      currentSessionId: AuthSessionId,
      targetSessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ServerAuthForbiddenOperationError | ServerAuthInternalError>;
    readonly revokeOtherClientSessions: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<number, ServerAuthInternalError>;
    readonly authenticateHttpRequest: (
      request: Pick<HttpServerRequest.HttpServerRequest, "cookies" | "headers">,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly authenticateWebSocketUpgrade: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly issueWebSocketTicket: (
      session: Pick<AuthenticatedSession, "sessionId">,
    ) => Effect.Effect<AuthWebSocketTicketResult, ServerAuthInternalError>;
    readonly issueStartupPairingUrl: (
      baseUrl: string,
    ) => Effect.Effect<string, ServerAuthInternalError>;
  }
>()("akeru-bot/auth/EnvironmentAuth") {}

type BootstrapExchangeResult = {
  readonly response: AuthBrowserSessionResult;
  readonly sessionToken: string;
};

const AUTHORIZATION_PREFIX = "Bearer ";

const WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";

const bySessionPriority = (left: AuthClientSession, right: AuthClientSession) => {
  const leftCanManage = left.scopes.includes(AuthAccessWriteScope);
  const rightCanManage = right.scopes.includes(AuthAccessWriteScope);

  if (leftCanManage !== rightCanManage) {
    return leftCanManage ? -1 : 1;
  }

  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }

  return right.issuedAt.epochMilliseconds - left.issuedAt.epochMilliseconds;
};

export function toBootstrapExchangeError(
  cause: PairingGrantStore.BootstrapCredentialError,
): ServerAuthInvalidCredentialError | ServerAuthInternalError {
  if (PairingGrantStore.isBootstrapCredentialInternalError(cause)) {
    return new ServerAuthBootstrapCredentialValidationError({ cause });
  }

  return new ServerAuthInvalidCredentialError({
    cause,
  });
}

const mapSessionVerificationErrors = <A, R>(
  effect: Effect.Effect<A, SessionStore.SessionCredentialError, R>,
): Effect.Effect<A, ServerAuthInvalidCredentialError | ServerAuthInternalError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      SessionStore.isSessionCredentialInvalidError(cause)
        ? new ServerAuthInvalidCredentialError({ cause })
        : new ServerAuthSessionCredentialValidationError({ cause }),
    ),
  );

function parseBearerToken(
  request: Pick<HttpServerRequest.HttpServerRequest, "headers">,
): string | null {
  const header = request.headers["authorization"];

  if (!Predicate.isString(header) || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }

  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();

  return token.length > 0 ? token : null;
}

export function selectRequestCredential(
  request: Pick<HttpServerRequest.HttpServerRequest, "cookies" | "headers">,
  cookieName: string,
  legacyCookieName: string | undefined,
) {
  const cookieToken = request.cookies[cookieName];

  if (cookieToken !== undefined) {
    return { token: cookieToken, source: "cookie" } as const;
  }

  const bearerToken = parseBearerToken(request);

  if (bearerToken !== null) {
    return { token: bearerToken, source: "bearer" } as const;
  }

  const legacyToken = legacyCookieName ? request.cookies[legacyCookieName] : undefined;

  if (legacyToken !== undefined) {
    return { token: legacyToken, source: "legacy-cookie" } as const;
  }

  return undefined;
}

export const make = Effect.gen(function* () {
  const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
  const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
  const sessions = yield* SessionStore.SessionStore;
  const descriptor = yield* policy.getDescriptor();
  // Pairing redemptions run one at a time, so a first admin revokes other admin
  // links before a concurrent redemption can consume one.
  const redeemLock = yield* Semaphore.make(1);

  const authenticateToken = (
    token: string,
  ): Effect.Effect<
    AuthenticatedSession,
    ServerAuthInvalidCredentialError | ServerAuthInternalError
  > =>
    sessions.verify(token).pipe(
      Effect.tapError((cause) =>
        SessionStore.isSessionCredentialInvalidError(cause)
          ? Effect.logWarning("Rejected authenticated session credential.").pipe(
              Effect.annotateLogs({
                reason: cause.message,
              }),
            )
          : Effect.void,
      ),
      Effect.map((session) => ({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        scopes: session.scopes,
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      })),
      mapSessionVerificationErrors,
    );

  const authenticateRequest = (
    request: Pick<HttpServerRequest.HttpServerRequest, "cookies" | "headers">,
  ): Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError> => {
    const credential = selectRequestCredential(
      request,
      sessions.cookieName,
      sessions.legacyCookieName,
    );

    if (!credential?.token) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }

    return authenticateToken(credential.token);
  };

  const getSessionState: EnvironmentAuth["Service"]["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            auth: descriptor,
            scopes: session.scopes,
            sessionMethod: session.method,
            ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
          }) satisfies AuthSessionState,
      ),
      Effect.catchIf(isServerAuthCredentialError, () =>
        Effect.succeed({
          authenticated: false,
          auth: descriptor,
        } satisfies AuthSessionState),
      ),
      Effect.withSpan("EnvironmentAuth.getSessionState"),
    );

  /**
   * Issues a session for a redeemed pairing grant. The first person-held admin session closes
   * first-admin bootstrap, so admin links issued before it stop working.
   */
  const issueGrantSession = <A, E, R>(
    scopes: ReadonlyArray<AuthEnvironmentScope>,
    client: AuthClientMetadata,
    issue: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const firstAdmin =
        hasPairedAdminClient([{ scopes, client }]) &&
        !hasPairedAdminClient(yield* sessions.listActive());

      const session = yield* issue;

      if (firstAdmin) {
        const links = yield* bootstrapCredentials.listActive();
        yield* Effect.forEach(
          links.filter((link) => link.scopes.includes(AuthAccessWriteScope)),
          (link) => bootstrapCredentials.revoke(link.id),
          { discard: true },
        );
      }

      return session;
    });

  const createBrowserSession: EnvironmentAuth["Service"]["createBrowserSession"] = (
    credential,
    requestMetadata,
  ) =>
    bootstrapCredentials.consume(credential).pipe(
      Effect.mapError(toBootstrapExchangeError),
      Effect.flatMap((grant) =>
        issueGrantSession(
          grant.scopes,
          requestMetadata,
          sessions.issue({
            method: "browser-session-cookie",
            subject: grant.subject,
            scopes: grant.scopes,
            client: {
              ...requestMetadata,
              ...(grant.label ? { label: grant.label } : {}),
            },
          }),
        ).pipe(Effect.mapError((cause) => new ServerAuthAuthenticatedSessionIssueError({ cause }))),
      ),
      Effect.map(
        (session) =>
          ({
            response: {
              authenticated: true,
              scopes: session.scopes,
              sessionMethod: session.method,
              expiresAt: DateTime.toUtc(session.expiresAt),
            } satisfies AuthBrowserSessionResult,
            sessionToken: session.token,
          }) satisfies BootstrapExchangeResult,
      ),
      redeemLock.withPermits(1),
      Effect.withSpan("EnvironmentAuth.createBrowserSession"),
    );

  const exchangeBootstrapCredentialForAccessToken: EnvironmentAuth["Service"]["exchangeBootstrapCredentialForAccessToken"] =
    (credential, requestedScopes, requestMetadata) =>
      bootstrapCredentials.consume(credential).pipe(
        Effect.mapError(toBootstrapExchangeError),
        Effect.flatMap((grant) =>
          Effect.gen(function* () {
            const grantedScopes = requestedScopes ?? grant.scopes;

            if (!grantedScopes.every((scope) => grant.scopes.includes(scope))) {
              return yield* new ServerAuthScopeNotGrantedError({});
            }

            return yield* issueGrantSession(
              grantedScopes,
              requestMetadata,
              sessions.issue({
                method: "bearer-access-token",
                subject: grant.subject,
                scopes: grantedScopes,
                client: {
                  ...requestMetadata,
                  ...(grant.label ? { label: grant.label } : {}),
                },
              }),
            ).pipe(
              Effect.mapError(
                (cause) => new ServerAuthAuthenticatedAccessTokenIssueError({ cause }),
              ),
            );
          }),
        ),
        Effect.flatMap((session) =>
          DateTime.now.pipe(
            Effect.map(
              (now) =>
                ({
                  access_token: session.token,
                  issued_token_type: AuthAccessTokenType,
                  token_type: "Bearer",
                  expires_in: Math.max(
                    0,
                    Math.floor(
                      (session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1000,
                    ),
                  ),
                  scope: encodeOAuthScope(session.scopes),
                }) satisfies AuthAccessTokenResult,
            ),
          ),
        ),
        redeemLock.withPermits(1),
        Effect.withSpan("EnvironmentAuth.exchangeBootstrapCredentialForAccessToken"),
      );

  const issuePairingCredentialForSubject = (input: {
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly subject: string;
    readonly label?: string;
    readonly purpose?: "startup";
  }) =>
    createPairingLink({
      scopes: input.scopes,
      subject: input.subject,
      ...(input.label ? { label: input.label } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
    }).pipe(
      Effect.map(
        (issued) =>
          ({
            id: issued.id,
            credential: issued.credential,
            ...(issued.label ? { label: issued.label } : {}),
            expiresAt: issued.expiresAt,
          }) satisfies AuthPairingCredentialResult,
      ),
    );

  const createPairingLink: EnvironmentAuth["Service"]["createPairingLink"] = Effect.fn(
    "EnvironmentAuth.createPairingLink",
  )(
    function* (input) {
      const createdAt = yield* DateTime.now;

      const issued = yield* bootstrapCredentials.issueOneTimeToken({
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...(input?.ttl ? { ttl: input.ttl } : {}),
        ...(input?.label ? { label: input.label } : {}),
        ...(input?.purpose ? { purpose: input.purpose } : {}),
      });

      return {
        id: issued.id,
        credential: issued.credential,
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...(issued.label ? { label: issued.label } : {}),
        createdAt: DateTime.toUtc(createdAt),
        expiresAt: DateTime.toUtc(issued.expiresAt),
      } satisfies IssuedPairingLink;
    },
    Effect.mapError((cause) => new ServerAuthPairingLinkCreationError({ cause })),
  );

  const listPairingLinks: EnvironmentAuth["Service"]["listPairingLinks"] = (input) =>
    bootstrapCredentials.listActive().pipe(
      Effect.map((pairingLinks) => {
        const excludedSubjects = input?.excludeSubjects ?? [
          INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        ];

        return pairingLinks
          .filter((pairingLink) => !excludedSubjects.includes(pairingLink.subject))
          .toSorted(
            (left, right) => right.createdAt.epochMilliseconds - left.createdAt.epochMilliseconds,
          );
      }),
      Effect.mapError((cause) => new ServerAuthPairingLinksListError({ cause })),
      Effect.withSpan("EnvironmentAuth.listPairingLinks"),
    );

  const revokePairingLink: EnvironmentAuth["Service"]["revokePairingLink"] = (id) =>
    bootstrapCredentials.revoke(id).pipe(
      Effect.mapError((cause) => new ServerAuthPairingLinkRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokePairingLink"),
    );

  const issueSession: EnvironmentAuth["Service"]["issueSession"] = (input) =>
    sessions
      .issue({
        subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
        method: "bearer-access-token",
        scopes: input?.scopes ?? AuthAdministrativeScopes,
        client: {
          ...(input?.label ? { label: input.label } : {}),
          deviceType: "bot",
        },
        ...(input?.ttl ? { ttl: input.ttl } : {}),
      })
      .pipe(
        Effect.map(
          (issued) =>
            ({
              sessionId: issued.sessionId,
              token: issued.token,
              method: "bearer-access-token",
              scopes: issued.scopes,
              subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
              client: issued.client,
              expiresAt: DateTime.toUtc(issued.expiresAt),
            }) satisfies IssuedBearerSession,
        ),
        Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })),
        Effect.withSpan("EnvironmentAuth.issueSession"),
      );

  const listSessions: EnvironmentAuth["Service"]["listSessions"] = () =>
    sessions.listActive().pipe(
      Effect.map((activeSessions) => activeSessions.toSorted(bySessionPriority)),
      Effect.mapError((cause) => new ServerAuthSessionsListError({ cause })),
      Effect.withSpan("EnvironmentAuth.listSessions"),
    );

  const revokeSession: EnvironmentAuth["Service"]["revokeSession"] = (sessionId) =>
    sessions.revoke(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthSessionRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeSession"),
    );

  const revokeOtherSessionsExcept: EnvironmentAuth["Service"]["revokeOtherSessionsExcept"] = (
    sessionId,
  ) =>
    sessions.revokeAllExcept(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthOtherSessionsRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeOtherSessionsExcept"),
    );

  const issuePairingCredential: EnvironmentAuth["Service"]["issuePairingCredential"] = (input) =>
    issuePairingCredentialForSubject({
      scopes: input?.scopes ?? AuthStandardClientScopes,
      subject: "one-time-token",
      ...(input?.label ? { label: input.label } : {}),
    }).pipe(Effect.withSpan("EnvironmentAuth.issuePairingCredential"));

  const issueStartupPairingCredential: EnvironmentAuth["Service"]["issueStartupPairingCredential"] =
    () =>
      issuePairingCredentialForSubject({
        scopes: AuthAdministrativeScopes,
        subject: INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        purpose: "startup",
      }).pipe(Effect.withSpan("EnvironmentAuth.issueStartupPairingCredential"));

  const listClientSessions: EnvironmentAuth["Service"]["listClientSessions"] = (currentSessionId) =>
    listSessions().pipe(
      Effect.map((clientSessions) =>
        clientSessions.map(
          (clientSession): AuthClientSession => ({
            ...clientSession,
            current: clientSession.sessionId === currentSessionId,
          }),
        ),
      ),
      Effect.withSpan("EnvironmentAuth.listClientSessions"),
    );

  const revokeClientSession: EnvironmentAuth["Service"]["revokeClientSession"] = Effect.fn(
    "EnvironmentAuth.revokeClientSession",
  )(function* (currentSessionId, targetSessionId) {
    if (currentSessionId === targetSessionId) {
      return yield* new ServerAuthForbiddenOperationError({});
    }

    return yield* revokeSession(targetSessionId);
  });

  const revokeOtherClientSessions: EnvironmentAuth["Service"]["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.withSpan("EnvironmentAuth.revokeOtherClientSessions"),
    );

  const issueStartupPairingUrl: EnvironmentAuth["Service"]["issueStartupPairingUrl"] = (baseUrl) =>
    issueStartupPairingCredential().pipe(
      Effect.map((issued) => {
        const url = new URL(baseUrl);
        url.pathname = "/pair";
        url.searchParams.delete("token");
        url.hash = new URLSearchParams([["token", issued.credential]]).toString();

        return url.toString();
      }),
      Effect.withSpan("EnvironmentAuth.issueStartupPairingUrl"),
    );

  const issueWebSocketTicket: EnvironmentAuth["Service"]["issueWebSocketTicket"] = (session) =>
    sessions.issueWebSocketToken(session.sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthWebSocketTokenIssueError({ cause })),
      Effect.map(
        (issued) =>
          ({
            ticket: issued.token,
            expiresAt: DateTime.toUtc(issued.expiresAt),
          }) satisfies AuthWebSocketTicketResult,
      ),
      Effect.withSpan("EnvironmentAuth.issueWebSocketTicket"),
    );

  const authenticateHttpRequest: EnvironmentAuth["Service"]["authenticateHttpRequest"] = (
    request,
  ) =>
    authenticateRequest(request).pipe(Effect.withSpan("EnvironmentAuth.authenticateHttpRequest"));

  const authenticateWebSocketUpgrade: EnvironmentAuth["Service"]["authenticateWebSocketUpgrade"] =
    Effect.fn("EnvironmentAuth.authenticateWebSocketUpgrade")(function* (request) {
      const requestUrl = HttpServerRequest.toURL(request);

      if (Option.isSome(requestUrl)) {
        const websocketTicket = requestUrl.value.searchParams.get(WEBSOCKET_TICKET_QUERY_PARAM);

        if (websocketTicket && websocketTicket.trim().length > 0) {
          return yield* sessions.verifyWebSocketToken(websocketTicket).pipe(
            Effect.map((session) => ({
              sessionId: session.sessionId,
              subject: session.subject,
              method: session.method,
              scopes: session.scopes,
              ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
            })),
            mapSessionVerificationErrors,
          );
        }
      }

      return yield* authenticateRequest(request);
    });

  return EnvironmentAuth.of({
    getDescriptor: () =>
      Effect.succeed(descriptor).pipe(Effect.withSpan("EnvironmentAuth.getDescriptor")),
    getSessionState,
    createBrowserSession,
    exchangeBootstrapCredentialForAccessToken,
    createPairingLink,
    issuePairingCredential,
    issueStartupPairingCredential,
    listPairingLinks,
    revokePairingLink,
    issueSession,
    listSessions,
    revokeSession,
    revokeOtherSessionsExcept,
    listClientSessions,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketTicket,
    issueStartupPairingUrl,
  });
});

export const layer = Layer.effect(EnvironmentAuth, make).pipe(
  Layer.provideMerge(PairingGrantStore.layer),
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(EnvironmentAuthPolicy.layer),
);

export const storageLayer = Layer.mergeAll(ServerSecretStore.layer, SqlitePersistenceLayer);

export const runtimeLayer = layer.pipe(
  Layer.provideMerge(storageLayer),
  Layer.provideMerge(ServerEnvironment.identityLayer),
);

export { DEFAULT_SESSION_SUBJECT } from "./EnvironmentAuthTypes.ts";

export { INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT } from "./EnvironmentAuthTypes.ts";

export { isEnvironmentHostSessionSubject } from "./EnvironmentAuthTypes.ts";

export type { IssuedPairingLink } from "./EnvironmentAuthTypes.ts";

export type { IssuedBearerSession } from "./EnvironmentAuthTypes.ts";

export type { AuthenticatedSession } from "./EnvironmentAuthTypes.ts";

export { ServerAuthBootstrapCredentialValidationError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthSessionCredentialValidationError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthAuthenticatedSessionIssueError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthAuthenticatedAccessTokenIssueError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthPairingLinkCreationError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthPairingLinksListError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthPairingLinkRevocationError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthSessionTokenIssueError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthSessionsListError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthSessionRevocationError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthOtherSessionsRevocationError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthWebSocketTokenIssueError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthInternalError } from "./EnvironmentAuthErrors.ts";

export { isServerAuthInternalError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthMissingCredentialError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthInvalidCredentialError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthCredentialError } from "./EnvironmentAuthErrors.ts";

export { isServerAuthCredentialError } from "./EnvironmentAuthErrors.ts";

export { serverAuthCredentialReason } from "./EnvironmentAuthErrors.ts";

export { ServerAuthInvalidScopeError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthScopeNotGrantedError } from "./EnvironmentAuthErrors.ts";

export { ServerAuthInvalidRequestError } from "./EnvironmentAuthErrors.ts";

export { isServerAuthInvalidRequestError } from "./EnvironmentAuthErrors.ts";

export { serverAuthInvalidRequestReason } from "./EnvironmentAuthErrors.ts";

export { ServerAuthForbiddenOperationError } from "./EnvironmentAuthErrors.ts";
