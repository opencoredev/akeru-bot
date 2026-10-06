import {
  AkeruCloudUrl,
  CLOUD_LINK_POLL_PATH,
  CLOUD_LINK_START_PATH,
  CloudAccount as CloudAccountSchema,
  CloudEnvironmentId,
  CloudLinkError,
  CloudLinkPollResponse,
  CloudLinkStartResponse,
  DEFAULT_AKERU_CLOUD_URL,
  STAGING_AKERU_CLOUD_URL,
  type CloudLinkStatus,
} from "@akeru/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** Secret-store entry holding the environment token. Nothing else may persist the token. */
export const CLOUD_LINK_SECRET = "akeru-cloud-link";

const StoredCloudLink = Schema.Struct({
  environmentId: CloudEnvironmentId,
  environmentToken: Schema.String,
  account: CloudAccountSchema,
  /**
   * The cloud that issued the token. A link always talks to this origin, whatever
   * settings resolve to later. A record without it does not decode and reads as unlinked.
   */
  cloudUrl: Schema.String,
});

export type CloudCredentials = typeof StoredCloudLink.Type;

const decodeStoredLink = Schema.decodeUnknownOption(Schema.fromJsonString(StoredCloudLink));

const encodeStoredLink = Schema.encodeSync(Schema.fromJsonString(StoredCloudLink));

const REVOKED_RECORD = '{"status":"revoked"}';

const textEncoder = new TextEncoder();

const textDecoder = new TextDecoder();

type ConnectionState = Extract<CloudLinkStatus, { status: "linked" }>["connection"];

/**
 * The cloud origin used when settings keep the production default. The server
 * sets it from `AKERU_CLOUD_URL`, or to staging when it runs from source in dev.
 */
export const CloudUrlFallbackRef = Context.Reference<string>(
  "akeru-bot/cloud/CloudAccount/CloudUrlFallback",
  { defaultValue: () => DEFAULT_AKERU_CLOUD_URL },
);

/** `AKERU_CLOUD_URL` wins; otherwise a server running from source (with a dev URL) uses staging. */
export const cloudUrlFallbackLayer = Layer.effect(
  CloudUrlFallbackRef,
  Effect.gen(function* () {
    const { devUrl } = yield* ServerConfig;
    const override = yield* Config.schema(AkeruCloudUrl, "AKERU_CLOUD_URL").pipe(Config.option);

    return Option.getOrElse(override, () =>
      devUrl ? STAGING_AKERU_CLOUD_URL : DEFAULT_AKERU_CLOUD_URL,
    );
  }),
);

/**
 * Picks the cloud for a NEW link: an `akeruCloudUrl` other than the production
 * default was set on purpose and wins; otherwise the server's fallback does.
 * An existing link never consults this; it keeps the origin that issued it.
 */
export const resolveCloudUrl = (configured: string, fallback: string) =>
  configured.replace(/\/+$/, "") === DEFAULT_AKERU_CLOUD_URL ? fallback : configured;

export interface CloudAccountShape {
  /** The cloud a new link would use. An existing link uses `CloudCredentials.cloudUrl`. */
  readonly cloudUrl: Effect.Effect<string>;
  readonly getStatus: Effect.Effect<CloudLinkStatus>;
  /** Current status first, then every change. */
  readonly streamStatus: Stream.Stream<CloudLinkStatus>;
  /** Starts the device link. Polling continues in the background until approval, denial, expiry, or cancel. */
  readonly link: Effect.Effect<CloudLinkStatus, CloudLinkError>;
  readonly cancelLink: Effect.Effect<CloudLinkStatus>;
  /** Forgets the token locally. The account page can revoke the environment on the cloud side. */
  readonly unlink: Effect.Effect<CloudLinkStatus, CloudLinkError>;
  /** Credentials for the socket, `null` while unlinked. Current value first, then changes. */
  readonly credentialChanges: Stream.Stream<CloudCredentials | null>;
  readonly setConnection: (connection: ConnectionState) => Effect.Effect<void>;
  readonly updateAccount: (account: CloudCredentials["account"]) => Effect.Effect<void>;
  /** Called when the cloud revokes this environment. Clears the token for good. */
  readonly markRevoked: Effect.Effect<void>;
}

export class CloudAccount extends Context.Service<CloudAccount, CloudAccountShape>()(
  "akeru-bot/cloud/CloudAccount",
) {}

const linkedStatus = (credentials: CloudCredentials, connection: ConnectionState) =>
  ({
    status: "linked",
    account: credentials.account,
    environmentId: credentials.environmentId,
    connection,
  }) satisfies CloudLinkStatus;

export const joinCloudUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;

const truncate = (value: string) => value.trim().slice(0, 128) || "Akeru Bot";

export const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;
  const settings = yield* ServerSettingsService;
  const environment = yield* ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const cloudUrlFallback = yield* CloudUrlFallbackRef;
  const pollHandle = yield* FiberHandle.make<void, never>();
  const mutex = yield* Semaphore.make(1);

  const storedRaw = yield* secretStore.get(CLOUD_LINK_SECRET).pipe(
    Effect.map(Option.map((bytes) => textDecoder.decode(bytes))),
    Effect.catch((error) =>
      Effect.logWarning("Could not read the Akeru Cloud link", { reason: error._tag }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
  );

  const stored = Option.flatMap(storedRaw, decodeStoredLink);
  const initiallyRevoked = Option.exists(storedRaw, (value) => value === REVOKED_RECORD);
  const initialCredentials = Option.getOrNull(stored);
  const credentialsRef = yield* SubscriptionRef.make<CloudCredentials | null>(initialCredentials);

  const statusRef = yield* SubscriptionRef.make<CloudLinkStatus>(
    initialCredentials
      ? linkedStatus(initialCredentials, "connecting")
      : { status: initiallyRevoked ? "revoked" : "unlinked" },
  );

  const unreachable = (message: string) => new CloudLinkError({ reason: "unreachable", message });

  const cloudUrl = settings.getSettings.pipe(
    Effect.map((current) => resolveCloudUrl(current.akeruCloudUrl, cloudUrlFallback)),
    Effect.orElseSucceed(() => cloudUrlFallback),
  );

  const postJson = <S extends Schema.Top>(
    baseUrl: string,
    path: string,
    body:
      | { readonly environmentName: string; readonly serverVersion: string }
      | { readonly deviceCode: string },
    schema: S,
  ) =>
    Effect.gen(function* () {
      const response = yield* httpClient
        .execute(
          HttpClientRequest.post(joinCloudUrl(baseUrl, path)).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(() => unreachable("Akeru Cloud could not be reached. Try again.")),
        );

      return yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError(
          () =>
            new CloudLinkError({
              reason: "invalid-response",
              message: "Akeru Cloud sent a response this version does not understand.",
            }),
        ),
      );
    });

  const saveCredentials = (credentials: CloudCredentials) =>
    secretStore.set(CLOUD_LINK_SECRET, textEncoder.encode(encodeStoredLink(credentials))).pipe(
      Effect.mapError(
        () =>
          new CloudLinkError({
            reason: "storage",
            message: "Could not save the Akeru Cloud link.",
          }),
      ),
    );

  const forget = secretStore.remove(CLOUD_LINK_SECRET).pipe(
    Effect.mapError(
      () =>
        new CloudLinkError({
          reason: "storage",
          message: "Could not remove the Akeru Cloud link.",
        }),
    ),
    Effect.andThen(SubscriptionRef.set(credentialsRef, null)),
  );

  const toUnlinkedIfLinking = SubscriptionRef.update(
    statusRef,
    (status): CloudLinkStatus => (status.status === "linking" ? { status: "unlinked" } : status),
  );

  const pollUntilDone = (baseUrl: string, start: CloudLinkStartResponse) =>
    Effect.gen(function* () {
      const expiresAt = Date.parse(start.expiresAt);
      const interval = Duration.seconds(start.pollIntervalSeconds);

      while (true) {
        yield* Effect.sleep(interval);

        if ((yield* Clock.currentTimeMillis) >= expiresAt) return yield* toUnlinkedIfLinking;

        const poll = yield* postJson(
          baseUrl,
          CLOUD_LINK_POLL_PATH,
          { deviceCode: start.deviceCode },
          CloudLinkPollResponse,
        ).pipe(
          Effect.catch((error) =>
            // A dropped poll is not fatal; the device code stays valid until it expires.
            Effect.logWarning("Akeru Cloud link poll failed", { reason: error.reason }).pipe(
              Effect.as({ status: "pending" } as const),
            ),
          ),
        );

        if (poll.status === "pending") continue;

        if (poll.status !== "approved") return yield* toUnlinkedIfLinking;

        return yield* approve({
          environmentId: poll.environmentId,
          environmentToken: poll.environmentToken,
          account: poll.account,
          cloudUrl: baseUrl,
        });
      }
    });

  // Saving the token and publishing `linked` happen together or not at all.
  // Waiting for the mutex stays interruptible, so a cancel that holds it wins
  // and nothing is saved; once approval holds it, cancel and unlink wait.
  const approve = (credentials: CloudCredentials) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* SubscriptionRef.get(statusRef)).status !== "linking") return;

        const saved = yield* saveCredentials(credentials).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logError("Akeru Cloud link could not be saved", { reason: error.reason }).pipe(
              Effect.as(false),
            ),
          ),
        );

        if (!saved) return yield* toUnlinkedIfLinking;
        yield* SubscriptionRef.set(credentialsRef, credentials);
        yield* SubscriptionRef.set(statusRef, linkedStatus(credentials, "connecting"));
      }).pipe(Effect.uninterruptible),
    );

  const cancelLink = mutex.withPermits(1)(
    FiberHandle.clear(pollHandle).pipe(
      Effect.andThen(toUnlinkedIfLinking),
      Effect.andThen(SubscriptionRef.get(statusRef)),
    ),
  );

  const link = mutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(statusRef);

      if (current.status === "linked") {
        return yield* new CloudLinkError({
          reason: "already-linked",
          message: "This environment is already connected to Akeru Cloud.",
        });
      }

      yield* FiberHandle.clear(pollHandle);
      const descriptor = yield* environment.getDescriptor;
      // Resolved once, so the whole device flow and the saved link share one origin.
      const baseUrl = yield* cloudUrl;

      const start = yield* postJson(
        baseUrl,
        CLOUD_LINK_START_PATH,
        {
          environmentName: truncate(descriptor.label),
          serverVersion: truncate(descriptor.serverVersion),
        },
        CloudLinkStartResponse,
      );

      const linking: CloudLinkStatus = {
        status: "linking",
        userCode: start.userCode,
        verificationUrl: start.verificationUrl,
        expiresAt: start.expiresAt,
      };

      yield* SubscriptionRef.set(statusRef, linking);
      yield* FiberHandle.run(pollHandle, pollUntilDone(baseUrl, start));

      return linking;
    }),
  );

  const unlink = mutex.withPermits(1)(
    Effect.gen(function* () {
      yield* FiberHandle.clear(pollHandle);
      yield* forget;
      yield* SubscriptionRef.set(statusRef, { status: "unlinked" });

      return yield* SubscriptionRef.get(statusRef);
    }),
  );

  const setConnection = (connection: ConnectionState) =>
    SubscriptionRef.update(statusRef, (status) =>
      status.status === "linked" && status.connection !== connection
        ? { ...status, connection }
        : status,
    );

  const updateAccount = (account: CloudCredentials["account"]) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const credentials = yield* SubscriptionRef.get(credentialsRef);

        if (!credentials || credentials.account.email === account.email) return;
        const next = { ...credentials, account };
        yield* saveCredentials(next).pipe(Effect.ignore);
        yield* SubscriptionRef.set(credentialsRef, next);
        yield* SubscriptionRef.update(statusRef, (status) =>
          status.status === "linked" ? { ...status, account } : status,
        );
      }),
    );

  // Uninterruptible: clearing credentials stops the socket session that calls this.
  const markRevoked = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        yield* FiberHandle.clear(pollHandle);
        yield* forget.pipe(
          Effect.catch(() =>
            secretStore.set(CLOUD_LINK_SECRET, textEncoder.encode(REVOKED_RECORD)).pipe(
              Effect.catch((error) =>
                Effect.logError("Could not persist Akeru Cloud revocation", {
                  reason: error._tag,
                }),
              ),
            ),
          ),
        );
        yield* SubscriptionRef.set(credentialsRef, null);
        yield* SubscriptionRef.set(statusRef, { status: "revoked" });
      }),
    )
    .pipe(Effect.uninterruptible);

  return CloudAccount.of({
    cloudUrl,
    getStatus: SubscriptionRef.get(statusRef),
    streamStatus: SubscriptionRef.changes(statusRef),
    link,
    cancelLink,
    unlink,
    credentialChanges: SubscriptionRef.changes(credentialsRef),
    setConnection,
    updateAccount,
    markRevoked,
  });
});

export const layer = Layer.effect(CloudAccount, make);
