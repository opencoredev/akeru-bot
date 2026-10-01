import * as Predicate from "effect/Predicate";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type AuthPairingLink,
} from "@akeru/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as AuthPairingLinks from "../persistence/AuthPairingLinks.ts";
import {
  type BootstrapGrant,
  UnknownBootstrapCredentialError,
  ExpiredBootstrapCredentialError,
  UnavailableBootstrapCredentialError,
  ActivePairingLinksLoadError,
  PairingLinkRevokeError,
  PairingCredentialIssueError,
  PairingCredentialRandomGenerationError,
  BootstrapCredentialConsumeAvailableError,
  BootstrapCredentialLookupError,
  BootstrapCredentialInternalError,
  BootstrapCredentialError,
  type IssuedBootstrapCredential,
  type BootstrapCredentialChange,
  type StoredBootstrapGrant,
  type ConsumeResult,
} from "./PairingGrantErrors.ts";
import {
  DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES,
  DESKTOP_BOOTSTRAP_TTL_HOURS,
  DEV_STARTUP_TTL_HOURS,
  PAIRING_TOKEN_ALPHABET,
  PAIRING_TOKEN_LENGTH,
  PAIRING_TOKEN_REJECTION_LIMIT,
} from "./PairingGrantTokens.ts";
export class PairingGrantStore extends Context.Service<
  PairingGrantStore,
  {
    readonly issueOneTimeToken: (input?: {
      readonly ttl?: Duration.Duration;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly subject?: string;
      readonly label?: string;
      /**
       * "startup" marks the credential the server mints for itself at boot,
       * which gets the long dev TTL when a dev URL is configured.
       */
      readonly purpose?: "startup";
    }) => Effect.Effect<IssuedBootstrapCredential, BootstrapCredentialInternalError>;
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<AuthPairingLink>,
      BootstrapCredentialInternalError
    >;
    readonly streamChanges: Stream.Stream<BootstrapCredentialChange>;
    readonly revoke: (id: string) => Effect.Effect<boolean, BootstrapCredentialInternalError>;
    readonly consume: (
      credential: string,
    ) => Effect.Effect<BootstrapGrant, BootstrapCredentialError>;
  }
>()("akeru-bot/auth/PairingGrantStore") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const pairingLinks = yield* AuthPairingLinks.AuthPairingLinkRepository;
  const seededGrantsRef = yield* Ref.make(new Map<string, StoredBootstrapGrant>());
  const changesPubSub = yield* PubSub.unbounded<BootstrapCredentialChange>();
  const generatePairingToken = Effect.gen(function* () {
    let credential = "";
    while (credential.length < PAIRING_TOKEN_LENGTH) {
      const bytes = yield* crypto
        .randomBytes(PAIRING_TOKEN_LENGTH)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PairingCredentialRandomGenerationError({ operation: "generate-token", cause }),
          ),
        );
      for (const byte of bytes) {
        if (byte >= PAIRING_TOKEN_REJECTION_LIMIT) {
          continue;
        }
        credential += PAIRING_TOKEN_ALPHABET[byte % PAIRING_TOKEN_ALPHABET.length]!;
        if (credential.length === PAIRING_TOKEN_LENGTH) {
          return credential;
        }
      }
    }
    return credential;
  });

  const seedGrant = (credential: string, grant: StoredBootstrapGrant) =>
    Ref.update(seededGrantsRef, (current) => {
      const next = new Map(current);
      next.set(credential, grant);
      return next;
    });

  const emitUpsert = (pairingLink: AuthPairingLink) =>
    PubSub.publish(changesPubSub, {
      type: "pairingLinkUpserted",
      pairingLink,
    }).pipe(Effect.asVoid);

  const emitRemoved = (id: string) =>
    PubSub.publish(changesPubSub, {
      type: "pairingLinkRemoved",
      id,
    }).pipe(Effect.asVoid);

  if (config.desktopBootstrapToken) {
    const now = yield* DateTime.now;
    yield* seedGrant(config.desktopBootstrapToken, {
      method: "desktop-bootstrap",
      scopes: AuthAdministrativeScopes,
      subject: "desktop-bootstrap",
      expiresAt: DateTime.add(now, {
        milliseconds: Duration.toMillis(DESKTOP_BOOTSTRAP_TTL_HOURS),
      }),
      // Unbounded uses so the renderer can re-exchange the seed for a
      // fresh bearer session after a page reload (or after the prior
      // bearer expires). The seed itself stays inside the desktop
      // process and the rendered page, both of which the user already
      // implicitly trusts.
      remainingUses: "unbounded",
    });
  }

  const listActive: PairingGrantStore["Service"]["listActive"] = Effect.fn(
    "PairingGrantStore.listActive",
  )(
    function* () {
      const now = yield* DateTime.now;
      const rows = yield* pairingLinks.listActive({ now });

      return rows.map((row) =>
        row.label
          ? ({
              id: row.id,
              credential: row.credential,
              scopes: row.scopes,
              subject: row.subject,
              label: row.label,
              createdAt: row.createdAt,
              expiresAt: row.expiresAt,
            } satisfies AuthPairingLink)
          : ({
              id: row.id,
              credential: row.credential,
              scopes: row.scopes,
              subject: row.subject,
              createdAt: row.createdAt,
              expiresAt: row.expiresAt,
            } satisfies AuthPairingLink),
      );
    },
    Effect.mapError((cause) => new ActivePairingLinksLoadError({ cause })),
  );

  const revoke: PairingGrantStore["Service"]["revoke"] = Effect.fn("PairingGrantStore.revoke")(
    function* (id) {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* pairingLinks
        .revoke({
          id,
          revokedAt,
        })
        .pipe(Effect.mapError((cause) => new PairingLinkRevokeError({ pairingLinkId: id, cause })));
      if (revoked) {
        yield* emitRemoved(id);
      }
      return revoked;
    },
  );

  const issueOneTimeToken: PairingGrantStore["Service"]["issueOneTimeToken"] = Effect.fn(
    "PairingGrantStore.issueOneTimeToken",
  )(function* (input) {
    const id = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) => new PairingCredentialRandomGenerationError({ operation: "generate-id", cause }),
      ),
    );
    const credential = yield* generatePairingToken;
    const isDevStartupToken = config.devUrl !== undefined && input?.purpose === "startup";
    const ttl =
      input?.ttl ??
      (isDevStartupToken ? DEV_STARTUP_TTL_HOURS : DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES);
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { milliseconds: Duration.toMillis(ttl) });
    const issued: IssuedBootstrapCredential = {
      id,
      credential,
      ...(input?.label ? { label: input.label } : {}),
      expiresAt,
    };
    const subject = input?.subject ?? "one-time-token";
    yield* pairingLinks
      .create({
        id,
        credential,
        method: "one-time-token",
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject,
        label: input?.label ?? null,
        createdAt: now,
        expiresAt: expiresAt,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PairingCredentialIssueError({
              pairingLinkId: id,
              subject,
              ...(input?.label ? { label: input.label } : {}),
              cause,
            }),
        ),
      );
    yield* emitUpsert({
      id,
      credential,
      scopes: input?.scopes ?? AuthStandardClientScopes,
      subject: input?.subject ?? "one-time-token",
      ...(input?.label ? { label: input.label } : {}),
      createdAt: now,
      expiresAt,
    });
    return issued;
  });

  const consume: PairingGrantStore["Service"]["consume"] = Effect.fn("PairingGrantStore.consume")(
    function* (credential) {
      const now = yield* DateTime.now;
      const seededResult: ConsumeResult = yield* Ref.modify(
        seededGrantsRef,
        (current): readonly [ConsumeResult, Map<string, StoredBootstrapGrant>] => {
          const grant = current.get(credential);
          if (!grant) {
            return [
              {
                _tag: "error",
                reason: "not-found",
                error: new UnknownBootstrapCredentialError({}),
              },
              current,
            ];
          }

          const next = new Map(current);
          if (DateTime.isGreaterThanOrEqualTo(now, grant.expiresAt)) {
            next.delete(credential);
            return [
              {
                _tag: "error",
                reason: "expired",
                error: new ExpiredBootstrapCredentialError({}),
              },
              next,
            ];
          }

          const remainingUses = grant.remainingUses;
          if (typeof remainingUses === "number") {
            if (remainingUses <= 1) {
              next.delete(credential);
            } else {
              next.set(credential, {
                ...grant,
                remainingUses: remainingUses - 1,
              });
            }
          }

          return [
            {
              _tag: "success",
              grant: {
                method: grant.method,
                scopes: grant.scopes,
                subject: grant.subject,
                ...(grant.label ? { label: grant.label } : {}),
                expiresAt: grant.expiresAt,
              } satisfies BootstrapGrant,
            },
            next,
          ];
        },
      );

      if (Predicate.isTagged(seededResult, "success")) {
        return seededResult.grant;
      }
      if (seededResult.reason !== "not-found") {
        return yield* seededResult.error;
      }

      const consumed = yield* pairingLinks
        .consumeAvailable({
          credential,
          consumedAt: now,
          now,
        })
        .pipe(Effect.mapError((cause) => new BootstrapCredentialConsumeAvailableError({ cause })));

      if (Option.isSome(consumed)) {
        yield* emitRemoved(consumed.value.id);
        return {
          method: consumed.value.method,
          scopes: consumed.value.scopes,
          subject: consumed.value.subject,
          ...(consumed.value.label ? { label: consumed.value.label } : {}),
          expiresAt: consumed.value.expiresAt,
        } satisfies BootstrapGrant;
      }

      const matching = yield* pairingLinks
        .getByCredential({ credential })
        .pipe(Effect.mapError((cause) => new BootstrapCredentialLookupError({ cause })));
      if (Option.isNone(matching)) {
        return yield* new UnknownBootstrapCredentialError({});
      }

      if (matching.value.revokedAt !== null) {
        return yield* new UnavailableBootstrapCredentialError({});
      }

      if (matching.value.consumedAt !== null) {
        return yield* new UnknownBootstrapCredentialError({});
      }

      if (DateTime.isGreaterThanOrEqualTo(now, matching.value.expiresAt)) {
        return yield* new ExpiredBootstrapCredentialError({});
      }

      return yield* new UnavailableBootstrapCredentialError({});
    },
  );

  return PairingGrantStore.of({
    issueOneTimeToken,
    listActive,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    consume,
  });
});

export const layer = Layer.effect(PairingGrantStore, make).pipe(
  Layer.provideMerge(AuthPairingLinks.layer),
);
export type { BootstrapGrant } from "./PairingGrantErrors.ts";
export { UnknownBootstrapCredentialError } from "./PairingGrantErrors.ts";
export { ExpiredBootstrapCredentialError } from "./PairingGrantErrors.ts";
export { UnavailableBootstrapCredentialError } from "./PairingGrantErrors.ts";
export { BootstrapCredentialInvalidError } from "./PairingGrantErrors.ts";
export { isBootstrapCredentialInvalidError } from "./PairingGrantErrors.ts";
export { ActivePairingLinksLoadError } from "./PairingGrantErrors.ts";
export { PairingLinkRevokeError } from "./PairingGrantErrors.ts";
export { PairingCredentialIssueError } from "./PairingGrantErrors.ts";
export { PairingCredentialRandomGenerationError } from "./PairingGrantErrors.ts";
export { BootstrapCredentialConsumeError } from "./PairingGrantErrors.ts";
export { BootstrapCredentialConsumeAvailableError } from "./PairingGrantErrors.ts";
export { BootstrapCredentialLookupError } from "./PairingGrantErrors.ts";
export { BootstrapCredentialInternalError } from "./PairingGrantErrors.ts";
export { isBootstrapCredentialInternalError } from "./PairingGrantErrors.ts";
export { BootstrapCredentialError } from "./PairingGrantErrors.ts";
export { isBootstrapCredentialError } from "./PairingGrantErrors.ts";
export type { IssuedBootstrapCredential } from "./PairingGrantErrors.ts";
export type { BootstrapCredentialChange } from "./PairingGrantErrors.ts";
