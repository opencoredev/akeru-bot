import * as Predicate from "effect/Predicate";
import * as NodeBuffer from "node:buffer";

import {
  CLOUD_LINK_POLL_PATH,
  CLOUD_LINK_START_PATH,
  CloudChannelRouteId,
  CloudEnvironmentId,
  CloudEnvironmentMessage,
  DEFAULT_AKERU_CLOUD_URL,
  EnvironmentId,
  type CloudLinkPollResponse,
  type CloudLinkStatus,
  type CloudServerMessage,
  type ExecutionEnvironmentDescriptor,
} from "@akeru/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { SecretStoreRemoveError, ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as CloudAccount from "./CloudAccount.ts";
import * as CloudConnection from "./CloudConnection.ts";
import * as HostedChannelRelay from "./HostedChannelRelay.ts";

export const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const fromJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const TOKEN = "env-token-secret-123";

export const CREDENTIALS = {
  environmentId: CloudEnvironmentId.make("env_1"),
  environmentToken: TOKEN,
  account: { email: "ada@example.com" },
};

/** A link saved on the production cloud, as the secret store holds it. */
const STORED_LINK = { ...CREDENTIALS, cloudUrl: DEFAULT_AKERU_CLOUD_URL };

export const ROUTE = CloudChannelRouteId.make("route_1");

/** `afterSet` runs once a value is written, standing in for a slow store acknowledging it. */
function memorySecretStore(
  initial?: Record<string, string>,
  afterSet: Effect.Effect<void> = Effect.void,
  failRemove = false,
) {
  const values = new Map<string, Uint8Array>(
    Object.entries(initial ?? {}).map(([key, value]) => [key, new TextEncoder().encode(value)]),
  );

  const store = ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => void values.set(name, value)).pipe(Effect.andThen(afterSet)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => values.get(name) ?? new Uint8Array(bytes)),
    remove: (name) =>
      failRemove
        ? Effect.fail(
            new SecretStoreRemoveError({ resource: name, cause: new Error("remove failed") }),
          )
        : Effect.sync(() => void values.delete(name)),
  });

  return { store, values };
}

/** Link endpoints of a fake cloud. Poll answers are consumed in order; the last one repeats. */
function fakeLinkClient(pollAnswers: ReadonlyArray<CloudLinkPollResponse>) {
  const requests: Array<{ readonly url: string; readonly body: string }> = [];
  let polls = 0;

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = Predicate.isTagged(request.body, "Uint8Array")
        ? new TextDecoder().decode(request.body.body)
        : "";

      requests.push({ url: request.url, body });

      const payload = request.url.endsWith(CLOUD_LINK_START_PATH)
        ? {
            deviceCode: "device-code-1",
            userCode: "ABCD-1234",
            verificationUrl: "https://cloud.test/link?code=ABCD-1234",
            expiresAt: "1970-01-01T00:10:00.000Z",
            pollIntervalSeconds: 5,
          }
        : request.url.endsWith(CLOUD_LINK_POLL_PATH)
          ? pollAnswers[Math.min(polls++, pollAnswers.length - 1)]
          : { error: "not found" };

      return HttpClientResponse.fromWeb(request, Response.json(payload));
    }),
  );

  return { client, requests };
}

export const inbound = (request: {
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body: Uint8Array | string;
}): CloudServerMessage => ({
  kind: "channel.inbound",
  routeId: ROUTE,
  provider: "slack",
  request: {
    method: "POST",
    path: request.path,
    headers: request.headers ?? {},
    bodyBase64: NodeBuffer.Buffer.from(request.body).toString("base64"),
    receivedAt: "1970-01-01T00:00:00.000Z",
  },
});

interface FakeSocket {
  readonly url: string;
  readonly token: string;
  readonly handlers: CloudConnection.CloudSocketHandlers;
  readonly sent: Queue.Queue<string>;
  closed: boolean;
}

/** Sockets share one outbound queue; each test only reads from the socket it is driving. */
const fakeSocketFactory = Effect.gen(function* () {
  const sockets = yield* Queue.unbounded<FakeSocket>();
  const sent = yield* Queue.unbounded<string>();

  const factory: CloudConnection.CloudSocketFactory = (url, token, handlers) => {
    const socket: FakeSocket = { url, token, handlers, sent, closed: false };
    Queue.offerUnsafe(sockets, socket);

    return {
      send: (data) => void Queue.offerUnsafe(socket.sent, data),
      close: () => {
        socket.closed = true;
      },
    };
  };

  return { sockets, factory };
});

export const receive = (socket: FakeSocket, message: CloudServerMessage | string) =>
  Effect.sync(() =>
    socket.handlers.onMessage(Predicate.isString(message) ? message : toJson(message)),
  );

const decodeEnvironmentMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(CloudEnvironmentMessage),
);

export const nextSent = (socket: FakeSocket) =>
  Queue.take(socket.sent).pipe(Effect.map(decodeEnvironmentMessage));

export const welcome: CloudServerMessage = {
  kind: "welcome",
  v: 1,
  environmentId: CREDENTIALS.environmentId,
  account: CREDENTIALS.account,
  capabilities: ["hosted-channels"],
};

const environmentLayer = Layer.succeed(
  ServerEnvironment,
  ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-test")),
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("environment-test"),
      label: "Test box",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.1.1",
      capabilities: { repositoryIdentity: true },
    } satisfies ExecutionEnvironmentDescriptor),
  }),
);

export function buildCloud(input: {
  /** `true` stores `STORED_LINK`; an object stores that exact link. */
  readonly linked?: boolean | object;
  readonly pollAnswers?: ReadonlyArray<CloudLinkPollResponse>;
  readonly afterSecretSet?: Effect.Effect<void>;
  readonly failRemove?: boolean;
  readonly cloudUrlFallback?: string;
}) {
  return Effect.gen(function* () {
    const secrets = memorySecretStore(
      input.linked
        ? {
            [CloudAccount.CLOUD_LINK_SECRET]: toJson(
              input.linked === true ? STORED_LINK : input.linked,
            ),
          }
        : undefined,
      input.afterSecretSet,
      input.failRemove,
    );

    const link = fakeLinkClient(input.pollAnswers ?? [{ status: "pending" }]);
    const sockets = yield* fakeSocketFactory;

    const context = yield* Layer.build(
      HostedChannelRelay.layer.pipe(
        Layer.provideMerge(CloudConnection.layer),
        Layer.provideMerge(CloudAccount.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerSecretStore, secrets.store),
            ServerSettingsService.layerTest(),
            environmentLayer,
            Layer.succeed(HttpClient.HttpClient, link.client),
            Layer.succeed(CloudConnection.CloudSocketFactoryRef, sockets.factory),
            input.cloudUrlFallback
              ? Layer.succeed(CloudAccount.CloudUrlFallbackRef, input.cloudUrlFallback)
              : Layer.empty,
          ),
        ),
      ),
    );

    return {
      account: Context.get(context, CloudAccount.CloudAccount),
      connection: Context.get(context, CloudConnection.CloudConnection),
      relay: Context.get(context, HostedChannelRelay.HostedChannelRelay),
      secrets: secrets.values,
      linkRequests: link.requests,
      sockets: sockets.sockets,
    };
  });
}

export const awaitStatus = (
  account: CloudAccount.CloudAccountShape,
  predicate: (status: CloudLinkStatus) => boolean,
) =>
  account.streamStatus.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.forkChild,
  );

export const openAndWelcome = (socket: FakeSocket) =>
  Effect.gen(function* () {
    socket.handlers.onOpen();
    const hello = yield* nextSent(socket);
    yield* receive(socket, welcome);

    return hello;
  });
