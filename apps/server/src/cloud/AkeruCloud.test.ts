import * as Predicate from "effect/Predicate";
import * as NodeBuffer from "node:buffer";

import { expect, it } from "@effect/vitest";
import {
  CLOUD_ENVIRONMENT_SOCKET_PATH,
  CLOUD_LINK_POLL_PATH,
  CLOUD_LINK_START_PATH,
  CloudChannelRouteId,
  CloudEnvironmentId,
  CloudEnvironmentMessage,
  DEFAULT_AKERU_CLOUD_URL,
  EnvironmentId,
  STAGING_AKERU_CLOUD_URL,
  type CloudLinkPollResponse,
  type CloudLinkStatus,
  type CloudServerMessage,
  type ExecutionEnvironmentDescriptor,
} from "@akeru/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as CloudAccount from "./CloudAccount.ts";
import * as CloudConnection from "./CloudConnection.ts";
import * as HostedChannelRelay from "./HostedChannelRelay.ts";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fromJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const TOKEN = "env-token-secret-123";

const CREDENTIALS = {
  environmentId: CloudEnvironmentId.make("env_1"),
  environmentToken: TOKEN,
  account: { email: "ada@example.com" },
};

/** A link saved on the production cloud, as the secret store holds it. */
const STORED_LINK = { ...CREDENTIALS, cloudUrl: DEFAULT_AKERU_CLOUD_URL };

const ROUTE = CloudChannelRouteId.make("route_1");

/** `afterSet` runs once a value is written, standing in for a slow store acknowledging it. */
function memorySecretStore(
  initial?: Record<string, string>,
  afterSet: Effect.Effect<void> = Effect.void,
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
    remove: (name) => Effect.sync(() => void values.delete(name)),
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

const inbound = (request: {
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

const receive = (socket: FakeSocket, message: CloudServerMessage | string) =>
  Effect.sync(() =>
    socket.handlers.onMessage(Predicate.isString(message) ? message : toJson(message)),
  );

const nextSent = (socket: FakeSocket) =>
  Queue.take(socket.sent).pipe(Effect.map((data) => fromJson(data) as CloudEnvironmentMessage));

const welcome: CloudServerMessage = {
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

function buildCloud(input: {
  /** `true` stores `STORED_LINK`; an object stores that exact link. */
  readonly linked?: boolean | object;
  readonly pollAnswers?: ReadonlyArray<CloudLinkPollResponse>;
  readonly afterSecretSet?: Effect.Effect<void>;
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

const awaitStatus = (
  account: CloudAccount.CloudAccountShape,
  predicate: (status: CloudLinkStatus) => boolean,
) =>
  account.streamStatus.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.forkChild,
  );

const openAndWelcome = (socket: FakeSocket) =>
  Effect.gen(function* () {
    socket.handlers.onOpen();
    const hello = yield* nextSent(socket);
    yield* receive(socket, welcome);

    return hello;
  });

describe("CloudAccount", () => {
  it.effect("links through the device flow and keeps the token out of status", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({
        pollAnswers: [
          { status: "pending" },
          { status: "approved", ...CREDENTIALS, environmentToken: TOKEN },
        ],
      });

      const linked = yield* awaitStatus(cloud.account, (status) => status.status === "linked");

      const linking = yield* cloud.account.link;
      expect(linking).toEqual({
        status: "linking",
        userCode: "ABCD-1234",
        verificationUrl: "https://cloud.test/link?code=ABCD-1234",
        expiresAt: "1970-01-01T00:10:00.000Z",
      });
      expect(fromJson(cloud.linkRequests[0]!.body)).toEqual({
        environmentName: "Test box",
        serverVersion: "0.1.1",
      });

      yield* TestClock.adjust("10 seconds");
      const status = yield* Fiber.join(linked);
      expect(status).toEqual({
        status: "linked",
        account: CREDENTIALS.account,
        environmentId: CREDENTIALS.environmentId,
        connection: "connecting",
      });
      expect(toJson(status)).not.toContain(TOKEN);
      expect(toJson(yield* cloud.account.getStatus)).not.toContain(TOKEN);
      expect(new TextDecoder().decode(cloud.secrets.get(CloudAccount.CLOUD_LINK_SECRET))).toContain(
        TOKEN,
      );

      const socket = yield* Queue.take(cloud.sockets);
      expect(socket.token).toBe(TOKEN);
      expect(socket.url).toBe(
        `wss://akeru-cloud.leoisadev.workers.dev${CLOUD_ENVIRONMENT_SOCKET_PATH}`,
      );
      expect(socket.url).not.toContain(TOKEN);
    }),
  );

  it.effect("returns to unlinked when the code expires", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ pollAnswers: [{ status: "pending" }] });
      yield* cloud.account.link;
      const unlinked = yield* awaitStatus(cloud.account, (status) => status.status === "unlinked");
      yield* TestClock.adjust("11 minutes");
      expect(yield* Fiber.join(unlinked)).toEqual({ status: "unlinked" });
      expect(cloud.secrets.size).toBe(0);
    }),
  );

  it.effect("cancels a pending link and unlinks a linked environment", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ pollAnswers: [{ status: "pending" }] });
      yield* cloud.account.link;
      expect(yield* cloud.account.cancelLink).toEqual({ status: "unlinked" });

      const linked = yield* buildCloud({ linked: true });
      const socket = yield* Queue.take(linked.sockets);
      expect(yield* linked.account.unlink).toEqual({ status: "unlinked" });
      expect(linked.secrets.size).toBe(0);
      expect(socket.closed).toBe(true);
    }),
  );

  it.effect("finishes an approval that a cancel races, instead of hiding a saved token", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const cloud = yield* buildCloud({
        pollAnswers: [{ status: "approved", ...CREDENTIALS }],
        afterSecretSet: Deferred.succeed(writing, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });

      yield* cloud.account.link;
      yield* TestClock.adjust("5 seconds");
      // The token is written and approval is still publishing when cancel arrives.
      yield* Deferred.await(writing);
      const cancel = yield* cloud.account.cancelLink.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);

      expect((yield* Fiber.join(cancel)).status).toBe("linked");
      expect((yield* cloud.account.getStatus).status).toBe("linked");
      expect(cloud.secrets.has(CloudAccount.CLOUD_LINK_SECRET)).toBe(true);
    }),
  );

  it.effect("cancels before approval publishes nothing", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ pollAnswers: [{ status: "approved", ...CREDENTIALS }] });
      yield* cloud.account.link;
      expect(yield* cloud.account.cancelLink).toEqual({ status: "unlinked" });
      yield* TestClock.adjust("10 seconds");
      expect(yield* cloud.account.getStatus).toEqual({ status: "unlinked" });
      expect(cloud.secrets.size).toBe(0);
    }),
  );

  it.effect(
    "picks the cloud for a new link from an explicit akeruCloudUrl, then the fallback",
    () =>
      Effect.sync(() => {
        expect(CloudAccount.resolveCloudUrl(DEFAULT_AKERU_CLOUD_URL, STAGING_AKERU_CLOUD_URL)).toBe(
          STAGING_AKERU_CLOUD_URL,
        );
        expect(
          CloudAccount.resolveCloudUrl(`${DEFAULT_AKERU_CLOUD_URL}/`, "http://localhost:1337"),
        ).toBe("http://localhost:1337");
        expect(
          CloudAccount.resolveCloudUrl("https://cloud.example.test", STAGING_AKERU_CLOUD_URL),
        ).toBe("https://cloud.example.test");
      }),
  );

  it.effect("links on the resolved cloud and stores that origin with the token", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({
        pollAnswers: [{ status: "approved", ...CREDENTIALS }],
        cloudUrlFallback: STAGING_AKERU_CLOUD_URL,
      });

      yield* cloud.account.link;
      yield* TestClock.adjust("5 seconds");
      expect(cloud.linkRequests.map((request) => request.url)).toEqual([
        `${STAGING_AKERU_CLOUD_URL}${CLOUD_LINK_START_PATH}`,
        `${STAGING_AKERU_CLOUD_URL}${CLOUD_LINK_POLL_PATH}`,
      ]);

      const saved = fromJson(
        new TextDecoder().decode(cloud.secrets.get(CloudAccount.CLOUD_LINK_SECRET)),
      );

      expect(saved).toMatchObject({ cloudUrl: STAGING_AKERU_CLOUD_URL });
      expect(toJson(yield* cloud.account.getStatus)).not.toContain("staging");
      const socket = yield* Queue.take(cloud.sockets);
      expect(socket.url).toBe(
        `wss://akeru-cloud-staging.leoisadev.workers.dev${CLOUD_ENVIRONMENT_SOCKET_PATH}`,
      );
    }),
  );
});

describe("CloudConnection linked origin", () => {
  it.effect("keeps a production link on a dev server whose fallback is staging", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true, cloudUrlFallback: STAGING_AKERU_CLOUD_URL });
      const socket = yield* Queue.take(cloud.sockets);
      expect(socket.url).toBe(
        `wss://akeru-cloud.leoisadev.workers.dev${CLOUD_ENVIRONMENT_SOCKET_PATH}`,
      );

      const connected = yield* awaitStatus(
        cloud.account,
        (next) => next.status === "linked" && next.connection === "connected",
      );

      yield* openAndWelcome(socket);
      yield* Fiber.join(connected);
      expect(cloud.secrets.size).toBe(1);
    }),
  );

  it.effect("revokes on a 401 from the linked origin even when the fallback differs", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true, cloudUrlFallback: STAGING_AKERU_CLOUD_URL });
      const socket = yield* Queue.take(cloud.sockets);
      expect(socket.url).toContain("akeru-cloud.leoisadev");
      const revoked = yield* awaitStatus(cloud.account, (next) => next.status === "revoked");
      socket.handlers.onClose(401);
      yield* Fiber.join(revoked);
      expect(cloud.secrets.size).toBe(0);
    }),
  );

  it.effect("treats a stored link without its cloud as unlinked and never sends it", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({
        linked: CREDENTIALS,
        cloudUrlFallback: STAGING_AKERU_CLOUD_URL,
      });

      expect(yield* cloud.account.getStatus).toEqual({ status: "unlinked" });
      yield* TestClock.adjust("5 seconds");
      expect(yield* Queue.size(cloud.sockets)).toBe(0);
    }),
  );
});

describe("CloudConnection", () => {
  it.effect("sends hello, reports connected, and drops undecodable messages", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true });

      const connected = yield* awaitStatus(
        cloud.account,
        (status) => status.status === "linked" && status.connection === "connected",
      );

      const socket = yield* Queue.take(cloud.sockets);
      socket.handlers.onOpen();
      expect(yield* nextSent(socket)).toEqual({
        kind: "hello",
        v: 1,
        serverVersion: "0.1.1",
        environmentName: "Test box",
        // Nothing attaches to the relay yet, so hosted channels are not advertised.
        capabilities: [],
      });
      yield* receive(socket, "not json");
      yield* receive(socket, toJson({ kind: "surprise" }));
      yield* receive(socket, welcome);
      yield* Fiber.join(connected);
    }),
  );

  it.effect("reconnects with capped exponential backoff", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true });
      const first = yield* Queue.take(cloud.sockets);

      const offline = yield* awaitStatus(
        cloud.account,
        (status) => status.status === "linked" && status.connection === "offline",
      );

      first.handlers.onClose();
      yield* Fiber.join(offline);
      expect(first.closed).toBe(true);

      // First failed attempt waits between 1 and 2 seconds.
      yield* TestClock.adjust("999 millis");
      expect(yield* Queue.size(cloud.sockets)).toBe(0);
      yield* TestClock.adjust("1001 millis");
      const second = yield* Queue.take(cloud.sockets);

      // Second failed attempt waits between 2 and 4 seconds.
      second.handlers.onClose();
      yield* TestClock.adjust("1999 millis");
      expect(yield* Queue.size(cloud.sockets)).toBe(0);
      yield* TestClock.adjust("2001 millis");
      const third = yield* Queue.take(cloud.sockets);

      // A welcomed session resets the backoff.
      yield* openAndWelcome(third);
      third.handlers.onClose();
      yield* TestClock.adjust("1 second");
      yield* Queue.take(cloud.sockets);
    }),
  );

  it.effect("closes a silent socket after missed heartbeats", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true });
      const socket = yield* Queue.take(cloud.sockets);
      yield* openAndWelcome(socket);
      yield* TestClock.adjust("20 seconds");
      expect(yield* nextSent(socket)).toEqual({ kind: "ping" });
      yield* TestClock.adjust("40 seconds");
      expect(socket.closed).toBe(true);
    }),
  );

  it.effect("forgets the token and stops reconnecting when revoked", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true });
      const socket = yield* Queue.take(cloud.sockets);
      yield* openAndWelcome(socket);
      const revoked = yield* awaitStatus(cloud.account, (status) => status.status === "revoked");
      yield* receive(socket, { kind: "revoked" });
      yield* Fiber.join(revoked);
      expect(cloud.secrets.size).toBe(0);
      expect(socket.closed).toBe(true);
      yield* TestClock.adjust("5 minutes");
      expect(yield* Queue.size(cloud.sockets)).toBe(0);
    }),
  );

  it.effect("correlates results by request id and times out unanswered requests", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true });

      const offline = yield* cloud.connection
        .request({ kind: "channel.route.delete", routeId: ROUTE })
        .pipe(Effect.flip);

      expect(offline.reason).toBe("offline");

      const socket = yield* Queue.take(cloud.sockets);
      yield* openAndWelcome(socket);

      const create = yield* cloud.connection
        .request({ kind: "channel.route.create", provider: "slack", label: "Ada" })
        .pipe(Effect.forkChild);

      const remove = yield* cloud.connection
        .request({ kind: "channel.route.delete", routeId: ROUTE })
        .pipe(Effect.forkChild);

      const createMessage = yield* nextSent(socket);
      const removeMessage = yield* nextSent(socket);
      expect(createMessage).toMatchObject({ kind: "channel.route.create", label: "Ada" });
      expect(removeMessage).toMatchObject({ kind: "channel.route.delete", routeId: ROUTE });

      if (
        createMessage.kind !== "channel.route.create" ||
        removeMessage.kind !== "channel.route.delete"
      ) {
        throw new Error("Expected cloud route requests.");
      }

      yield* receive(socket, {
        kind: "result",
        requestId: String(removeMessage.requestId),
        ok: false,
        code: "not-found",
        message: "No such route.",
      });

      const route = {
        routeId: ROUTE,
        provider: "slack" as const,
        inboundUrl: "https://cloud.test/in/route_1",
        oauthRedirectUrl: "https://cloud.test/oauth/route_1",
      };

      yield* receive(socket, {
        kind: "result",
        requestId: String(createMessage.requestId),
        ok: true,
        value: { type: "channel.route", route },
      });
      expect(yield* Fiber.join(create)).toEqual({ type: "channel.route", route });
      const rejected = yield* Fiber.await(remove);
      expect(Exit.isFailure(rejected)).toBe(true);
      expect(yield* Fiber.join(remove).pipe(Effect.flip)).toMatchObject({
        reason: "rejected",
        code: "not-found",
      });

      const late = yield* cloud.connection
        .request({ kind: "channel.route.delete", routeId: ROUTE })
        .pipe(Effect.flip, Effect.forkChild);

      yield* nextSent(socket);
      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(late)).reason).toBe("timeout");
    }),
  );
});

describe("CloudConnection handshake and unlink", () => {
  for (const status of [401, 410]) {
    it.effect(`forgets the token when the cloud refuses the upgrade with ${status}`, () =>
      Effect.gen(function* () {
        const cloud = yield* buildCloud({ linked: true });
        const socket = yield* Queue.take(cloud.sockets);
        const revoked = yield* awaitStatus(cloud.account, (next) => next.status === "revoked");
        socket.handlers.onClose(status);
        yield* Fiber.join(revoked);
        expect(cloud.secrets.size).toBe(0);
        yield* TestClock.adjust("5 minutes");
        expect(yield* Queue.size(cloud.sockets)).toBe(0);
      }),
    );
  }

  it.effect("keeps reconnecting after other handshake failures", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true });
      const socket = yield* Queue.take(cloud.sockets);
      socket.handlers.onClose(503);
      yield* TestClock.adjust("2 seconds");
      yield* Queue.take(cloud.sockets);
      expect(cloud.secrets.size).toBe(1);
    }),
  );

  it.effect("asks the cloud to unlink before forgetting the token", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true });
      const socket = yield* Queue.take(cloud.sockets);
      yield* openAndWelcome(socket);
      const unlink = yield* cloud.connection.unlink.pipe(Effect.forkChild);
      const message = yield* nextSent(socket);
      expect(message).toMatchObject({ kind: "environment.unlink" });

      if (message.kind !== "environment.unlink") {
        throw new Error("Expected an environment unlink request.");
      }

      expect(cloud.secrets.size).toBe(1);
      yield* receive(socket, {
        kind: "result",
        requestId: String(message.requestId),
        ok: true,
        value: { type: "empty" },
      });
      expect(yield* Fiber.join(unlink)).toEqual({ status: "unlinked" });
      expect(cloud.secrets.size).toBe(0);
      yield* TestClock.adjust("5 minutes");
      expect(socket.closed).toBe(true);
      expect(yield* Queue.size(cloud.sockets)).toBe(0);
    }),
  );

  it.effect("unlinks locally when the cloud is offline or silent", () =>
    Effect.gen(function* () {
      const offline = yield* buildCloud({ linked: true });
      expect(yield* offline.connection.unlink).toEqual({ status: "unlinked" });
      expect(offline.secrets.size).toBe(0);

      const silent = yield* buildCloud({ linked: true });
      const socket = yield* Queue.take(silent.sockets);
      yield* openAndWelcome(socket);
      const unlink = yield* silent.connection.unlink.pipe(Effect.forkChild);
      yield* nextSent(socket);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(unlink)).toEqual({ status: "unlinked" });
      expect(silent.secrets.size).toBe(0);
    }),
  );
});

describe("HostedChannelRelay", () => {
  it.effect("rebuilds forwarded requests and hands them to the attached webhook", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true });
      const received = yield* Queue.unbounded<Request>();
      yield* cloud.relay.attach(ROUTE, {
        webhook: async (request) => {
          Queue.offerUnsafe(received, request);

          return new Response("ok");
        },
      });
      const socket = yield* Queue.take(cloud.sockets);
      yield* openAndWelcome(socket);
      yield* receive(
        socket,
        inbound({
          path: "/events?retry=1",
          headers: {
            "content-type": "application/json",
            "x-slack-signature": "v0=abc",
            host: "cloud.test",
          },
          body: '{"type":"event_callback"}',
        }),
      );
      const request = yield* Queue.take(received);
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/routes/route_1/events");
      expect(new URL(request.url).search).toBe("?retry=1");
      expect(request.headers.get("x-slack-signature")).toBe("v0=abc");
      expect(request.headers.get("host")).toBeNull();
      expect(yield* Effect.promise(() => request.text())).toBe('{"type":"event_callback"}');

      yield* cloud.relay.detach(ROUTE);
      expect(yield* cloud.relay.missed(ROUTE)).toBeUndefined();
    }),
  );

  it.effect("hands the webhook the exact body bytes, even when they are not UTF-8", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true });
      const received = yield* Queue.unbounded<Request>();
      yield* cloud.relay.attach(ROUTE, {
        webhook: async (request) => {
          Queue.offerUnsafe(received, request);

          return new Response("ok");
        },
      });
      const socket = yield* Queue.take(cloud.sockets);
      yield* openAndWelcome(socket);
      const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80, 0x7d]);
      yield* receive(socket, inbound({ path: "/", body: bytes }));
      const request = yield* Queue.take(received);
      const body = yield* Effect.promise(() => request.arrayBuffer());
      expect(new Uint8Array(body)).toEqual(bytes);
    }),
  );

  it("refuses forwarded paths that leave the route", () => {
    const forwarded = (path: string) => ({
      method: "POST" as const,
      path,
      headers: {},
      bodyBase64: "",
      receivedAt: "1970-01-01T00:00:00.000Z",
    });

    for (const path of [
      "/../other",
      "/events/..",
      "/./events",
      "/%2e%2e/other",
      "/%2E%2e/other",
      "/.%2E/other",
      "/%2e/events",
      "/a%2f..%2fb",
      "/events#frag",
      "/events\\..\\x",
      "//evil.test/events",
      "/%zz",
    ]) {
      expect(HostedChannelRelay.toWebRequest(ROUTE, forwarded(path)), path).toBeNull();
    }

    for (const path of ["", "/", "/events", "/events?x=../y", "/a..b/c", "/interactions"]) {
      const request = HostedChannelRelay.toWebRequest(ROUTE, forwarded(path));
      expect(request, path).not.toBeNull();
      expect(new URL(request!.url).pathname.startsWith("/routes/route_1")).toBe(true);
    }
  });
});
