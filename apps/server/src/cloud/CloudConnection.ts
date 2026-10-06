import WebSocket from "ws";
import * as Predicate from "effect/Predicate";
import * as NodeCrypto from "node:crypto";

import {
  CLOUD_ENVIRONMENT_SOCKET_PATH,
  CLOUD_PROTOCOL_VERSION,
  CloudEnvironmentMessage,
  CloudErrorCode,
  CloudServerMessage,
  type CloudCapability,
  type CloudLinkError,
  type CloudLinkStatus,
  type CloudRequestResult,
} from "@akeru/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { CloudAccount, type CloudCredentials, joinCloudUrl } from "./CloudAccount.ts";

export interface CloudSocketHandlers {
  readonly onOpen: () => void;
  readonly onMessage: (data: string) => void;
  /** Called once. `handshakeStatus` is the HTTP status when the cloud refused the upgrade. */
  readonly onClose: (handshakeStatus?: number) => void;
}

export interface CloudSocket {
  readonly send: (data: string) => void;
  readonly close: () => void;
}

/** Opens the outbound socket. The token goes only into the `Authorization` header, never the URL. */
export type CloudSocketFactory = (
  url: string,
  token: string,
  handlers: CloudSocketHandlers,
) => CloudSocket;

// The Node socket transport supports authenticated handshake headers.
export const openCloudSocket: CloudSocketFactory = (url, token, handlers) => {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const decoder = new TextDecoder();
  let settled = false;

  const settle = () => {
    if (settled) return;
    settled = true;

    handlers.onClose();
  };

  socket.addEventListener("open", () => {
    handlers.onOpen();
  });
  socket.on("unexpected-response", (_request, response) => {
    response.resume();

    if (settled) return;
    settled = true;
    handlers.onClose(response.statusCode);
    socket.close();
  });
  socket.addEventListener("close", settle);
  socket.addEventListener("error", settle);
  socket.addEventListener("message", (event) => {
    const data: unknown = event.data;

    if (Predicate.isString(data)) handlers.onMessage(data);
    else if (data instanceof ArrayBuffer) handlers.onMessage(decoder.decode(data));
  });

  return {
    send: (data) => {
      if (socket.readyState === socket.OPEN) socket.send(data);
    },
    close: () => {
      socket.close();
    },
  };
};

export const CloudSocketFactoryRef = Context.Reference<CloudSocketFactory>(
  "akeru-bot/cloud/CloudConnection/CloudSocketFactory",
  { defaultValue: () => openCloudSocket },
);

export class CloudRequestError extends Schema.TaggedErrorClass<CloudRequestError>()(
  "CloudRequestError",
  {
    reason: Schema.Literals(["offline", "timeout", "rejected"]),
    code: Schema.optionalKey(CloudErrorCode),
    message: Schema.String,
  },
) {}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type CloudRequestMessage = Extract<CloudEnvironmentMessage, { readonly requestId: string }>;

export type CloudRequest = DistributiveOmit<CloudRequestMessage, "requestId">;

/** Server messages that features handle. Protocol messages stay inside the connection. */
export type CloudDispatchKind = Exclude<
  CloudServerMessage["kind"],
  "welcome" | "pong" | "result" | "revoked"
>;

export type CloudDispatchMessage<K extends CloudDispatchKind> = Extract<
  CloudServerMessage,
  { readonly kind: K }
>;

type AnyHandler = (message: CloudServerMessage) => Effect.Effect<void>;

export interface CloudConnectionShape {
  /** Sends a request and waits for its `result`. Fails fast while the socket is not connected. */
  readonly request: (message: CloudRequest) => Effect.Effect<CloudRequestResult, CloudRequestError>;
  /** Handles one message kind until the registering scope closes. */
  readonly register: <K extends CloudDispatchKind>(
    kind: K,
    handler: (message: CloudDispatchMessage<K>) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Asks the cloud to revoke this environment, then forgets the token locally.
   * The cloud step is best effort: offline, the environment still unlinks, and
   * the account page can revoke it later.
   */
  readonly unlink: Effect.Effect<CloudLinkStatus, CloudLinkError>;
}

export class CloudConnection extends Context.Service<CloudConnection, CloudConnectionShape>()(
  "akeru-bot/cloud/CloudConnection",
) {}

// Advertise "hosted-channels" once a hosted channel runtime attaches to
// HostedChannelRelay. Until then the cloud would relay to nothing.
export const CLOUD_CAPABILITIES: ReadonlyArray<CloudCapability> = [];

export const CLOUD_HEARTBEAT_INTERVAL = Duration.seconds(20);

const STALE_AFTER_MS = 50_000;

export const CLOUD_REQUEST_TIMEOUT = Duration.seconds(15);

const UNLINK_TIMEOUT = Duration.seconds(5);

const BACKOFF_BASE_MS = 1_000;

export const CLOUD_BACKOFF_MAX_MS = 60_000;

const decodeServerMessage = Schema.decodeUnknownOption(Schema.fromJsonString(CloudServerMessage));

const encodeEnvironmentMessage = Schema.encodeSync(Schema.fromJsonString(CloudEnvironmentMessage));

type SocketEvent =
  | { readonly type: "open" }
  | { readonly type: "message"; readonly data: string }
  | { readonly type: "close"; readonly handshakeStatus?: number };

/** The cloud answers these to a refused upgrade when the token will never work again. */
const isRevokedHandshake = (status: number | undefined) => status === 401 || status === 410;

/** Equal jitter: half the capped exponential delay is fixed, the other half random. */
const backoffDelay = (attempt: number) =>
  Effect.map(Random.next, (random) => {
    const cap = Math.min(CLOUD_BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);

    return Duration.millis(cap / 2 + (random * cap) / 2);
  });

const toSocketUrl = (base: string) =>
  joinCloudUrl(base, CLOUD_ENVIRONMENT_SOCKET_PATH).replace(/^http/i, "ws");

export const make = Effect.gen(function* () {
  const account = yield* CloudAccount;
  const environment = yield* ServerEnvironment;
  const socketFactory = yield* CloudSocketFactoryRef;
  const layerScope = yield* Effect.scope;

  const handlers = new Map<CloudDispatchKind, Set<AnyHandler>>();
  const pending = new Map<string, Deferred.Deferred<CloudRequestResult, CloudRequestError>>();
  let connected: CloudSocket | null = null;

  const failPending = Effect.sync(() => {
    const waiting = [...pending.values()];
    pending.clear();

    return waiting;
  }).pipe(
    Effect.flatMap((waiting) =>
      Effect.forEach(
        waiting,
        (deferred) =>
          Deferred.fail(
            deferred,
            new CloudRequestError({ reason: "offline", message: "Akeru Cloud disconnected." }),
          ),
        { discard: true },
      ),
    ),
  );

  const dispatch = (message: CloudServerMessage & { readonly kind: CloudDispatchKind }) =>
    Effect.forEach(
      [...(handlers.get(message.kind) ?? [])],
      (handler) =>
        handler(message).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Akeru Cloud message handler failed", { kind: message.kind, cause }),
          ),
          // Handlers outlive the socket that delivered their message.
          Effect.forkIn(layerScope),
        ),
      { discard: true },
    );

  /** Connects to the cloud that issued the token, never the currently resolved one. */
  const runSocketOnce = (credentials: CloudCredentials) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<SocketEvent>();
      const baseUrl = credentials.cloudUrl;
      const descriptor = yield* environment.getDescriptor;

      const socket = yield* Effect.acquireRelease(
        Effect.sync(() =>
          socketFactory(toSocketUrl(baseUrl), credentials.environmentToken, {
            onOpen: () => Queue.offerUnsafe(events, { type: "open" }),
            onMessage: (data) => Queue.offerUnsafe(events, { type: "message", data }),
            onClose: (handshakeStatus) =>
              Queue.offerUnsafe(
                events,
                handshakeStatus === undefined
                  ? { type: "close" }
                  : { type: "close", handshakeStatus },
              ),
          }),
        ),
        (opened) =>
          Effect.sync(() => {
            if (connected === opened) connected = null;
            opened.close();
          }).pipe(Effect.andThen(failPending)),
      );

      const send = (message: CloudEnvironmentMessage) =>
        Effect.sync(() => socket.send(encodeEnvironmentMessage(message)));

      let lastInboundAt = yield* Clock.currentTimeMillis;
      let welcomed = false;
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(CLOUD_HEARTBEAT_INTERVAL);

            if ((yield* Clock.currentTimeMillis) - lastInboundAt > STALE_AFTER_MS) {
              Queue.offerUnsafe(events, { type: "close" });

              return;
            }

            yield* send({ kind: "ping" });
          }
        }),
      );

      while (true) {
        const event = yield* Queue.take(events);

        if (event.type === "close") {
          return { welcomed, revoked: isRevokedHandshake(event.handshakeStatus) };
        }

        if (event.type === "open") {
          yield* send({
            kind: "hello",
            v: CLOUD_PROTOCOL_VERSION,
            serverVersion: descriptor.serverVersion.slice(0, 128),
            environmentName: descriptor.label.trim().slice(0, 128) || "Akeru Bot",
            capabilities: [...CLOUD_CAPABILITIES],
          });
          continue;
        }

        lastInboundAt = yield* Clock.currentTimeMillis;
        const decoded = decodeServerMessage(event.data);

        if (Option.isNone(decoded)) {
          yield* Effect.logDebug("Dropped an undecodable Akeru Cloud message");
          continue;
        }

        const message = decoded.value;

        switch (message.kind) {
          case "welcome":
            welcomed = true;
            connected = socket;
            yield* account.updateAccount(message.account);
            yield* account.setConnection("connected");
            break;
          case "pong":
            break;
          case "result": {
            const deferred = pending.get(message.requestId);

            if (!deferred) break;
            pending.delete(message.requestId);
            yield* message.ok
              ? Deferred.succeed(deferred, message.value)
              : Deferred.fail(
                  deferred,
                  new CloudRequestError({
                    reason: "rejected",
                    code: message.code,
                    message: message.message,
                  }),
                );
            break;
          }

          case "revoked":
            return { welcomed, revoked: true };
          default:
            yield* dispatch(message);
        }
      }
    }).pipe(Effect.scoped);

  const runSession = (credentials: CloudCredentials) =>
    Effect.gen(function* () {
      let attempt = 0;

      while (true) {
        yield* account.setConnection("connecting");
        const outcome = yield* runSocketOnce(credentials);

        if (outcome.revoked) {
          yield* Effect.logInfo("Akeru Cloud revoked this environment");

          return yield* account.markRevoked;
        }

        yield* account.setConnection("offline");
        attempt = outcome.welcomed ? 0 : attempt + 1;
        yield* Effect.sleep(yield* backoffDelay(attempt));
      }
    });

  yield* account.credentialChanges.pipe(
    Stream.changesWith((left, right) => left?.environmentToken === right?.environmentToken),
    Stream.switchMap((credentials) =>
      credentials ? Stream.fromEffect(runSession(credentials)) : Stream.empty,
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );

  const request: CloudConnectionShape["request"] = (message) =>
    Effect.gen(function* () {
      const socket = connected;

      if (!socket) {
        return yield* new CloudRequestError({
          reason: "offline",
          message: "Akeru Cloud is not connected.",
        });
      }

      const requestId = NodeCrypto.randomUUID();
      const deferred = yield* Deferred.make<CloudRequestResult, CloudRequestError>();
      pending.set(requestId, deferred);
      socket.send(encodeEnvironmentMessage({ ...message, requestId }));

      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: CLOUD_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new CloudRequestError({
                reason: "timeout",
                message: "Akeru Cloud did not answer in time.",
              }),
            ),
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
      );
    });

  const register: CloudConnectionShape["register"] = (kind, handler) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        // SAFETY: the registry dispatches each handler only messages with its registered kind.
        const entry = handler as AnyHandler;
        const set = handlers.get(kind) ?? new Set<AnyHandler>();
        set.add(entry);
        handlers.set(kind, set);

        return entry;
      }),
      (entry) => Effect.sync(() => void handlers.get(kind)?.delete(entry)),
    ).pipe(Effect.asVoid);

  const unlink = request({ kind: "environment.unlink" }).pipe(
    Effect.timeout(UNLINK_TIMEOUT),
    Effect.catchTags({
      CloudRequestError: (error) =>
        Effect.logWarning("Akeru Cloud did not confirm the unlink; forgetting the token anyway", {
          reason: error.reason,
        }),
      TimeoutError: () =>
        Effect.logWarning("Akeru Cloud unlink timed out; forgetting the token anyway"),
    }),
    Effect.andThen(account.unlink),
  );

  return CloudConnection.of({ request, register, unlink });
});

export const layer = Layer.effect(CloudConnection, make);
