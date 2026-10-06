import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import {
  CLOUD_ENVIRONMENT_SOCKET_PATH,
  CLOUD_LINK_POLL_PATH,
  CLOUD_LINK_START_PATH,
  DEFAULT_AKERU_CLOUD_URL,
  STAGING_AKERU_CLOUD_URL,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as HostedChannelRelay from "./HostedChannelRelay.ts";
import * as CloudAccount from "./CloudAccount.ts";
import {
  TOKEN,
  CREDENTIALS,
  ROUTE,
  toJson,
  fromJson,
  inbound,
  receive,
  nextSent,
  buildCloud,
  awaitStatus,
  openAndWelcome,
  welcome,
} from "./AkeruCloud.test-support.ts";

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

  it.effect("persists a token-free revoked record when secret deletion fails", () =>
    Effect.gen(function* () {
      const cloud = yield* buildCloud({ linked: true, failRemove: true });
      yield* cloud.account.markRevoked;
      const encoded = new TextDecoder().decode(cloud.secrets.get(CloudAccount.CLOUD_LINK_SECRET));
      expect(encoded).toBe('{"status":"revoked"}');
      expect(encoded).not.toContain(CREDENTIALS.environmentToken);
      const restarted = yield* buildCloud({ linked: { status: "revoked" } });
      expect(yield* restarted.account.getStatus).toEqual({ status: "revoked" });
      expect(yield* Queue.size(restarted.sockets)).toBe(0);
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

  it.effect("keeps the credential when the cloud is offline or silent", () =>
    Effect.gen(function* () {
      const offline = yield* buildCloud({ linked: true });
      expect(yield* offline.connection.unlink.pipe(Effect.flip)).toMatchObject({
        reason: "unreachable",
      });
      expect(offline.secrets.size).toBe(1);

      const silent = yield* buildCloud({ linked: true });
      const socket = yield* Queue.take(silent.sockets);
      yield* openAndWelcome(socket);
      const unlink = yield* silent.connection.unlink.pipe(Effect.flip, Effect.forkChild);
      yield* nextSent(socket);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(unlink)).toMatchObject({ reason: "unreachable" });
      expect(silent.secrets.size).toBe(1);
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
