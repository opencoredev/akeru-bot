import {
  runWith,
  failureOf,
  expectFailureMessage,
  expectProviderFailure,
  connectChannel,
  saveChannelConnection,
  deleteChannelConnection,
  attachChannelConnection,
  detachChannelConnection,
  reconnectChannel,
  restoreConnectedChannels,
  sendChannelMessage,
  stopChannelsForBot,
  channelBindingsForRuntime,
  startTestGateway,
  NOW,
  BOT_ID,
  PROJECT_ID,
  makeBot,
  makeMessage,
  makeThread,
  makeHarness,
  telegramConnect,
  imessageConnect,
  discordConnect,
  photon,
} from "./testUtils/channelRuntime.ts";
import * as NodeUtil from "node:util";
import {
  BotId,
  ChannelConnectionId,
  CommandId,
  MessageId,
  ThreadId,
  type ChannelBinding,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { channelFailureMessage } from "./ChannelRuntime.ts";
describe("channel runtime", () => {
  describe("health", () => {
    it.effect("never marks a binding connected when its listener stopped before commit", () =>
      Effect.gen(function* () {
        let stops = 0;
        const statuses: string[] = [];
        const harness = makeHarness({
          onBindings: (bindings) => statuses.push(bindings[0]?.status ?? "none"),
          startTransport: async () => ({
            externalIdentity: "@akeru",
            runtime: {
              post: async () => undefined,
              shutdown: async () => void (stops += 1),
              isHealthy: () => false,
            },
          }),
        });

        yield* expectProviderFailure(
          connectChannel(harness.dependencies, telegramConnect(BOT_ID)),
          "telegram-token",
          "network",
        );

        expect(statuses).toEqual(["connecting", "none"]);
        expect(stops).toBe(1);
        expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
        expect(harness.secrets.size).toBe(0);
      }),
    );

    it.effect("rejects an iMessage gateway that refuses its first listener", () =>
      Effect.gen(function* () {
        photon.gatewayStatus = 401;
        const harness = makeHarness({ startTransport: null });

        yield* expectProviderFailure(
          connectChannel(harness.dependencies, imessageConnect(BOT_ID)),
          "status 401",
        );

        expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
        expect(harness.secrets.size).toBe(0);
      }),
    );

    it.effect("classifies an iMessage gateway that cannot be reached on first launch", () =>
      Effect.gen(function* () {
        photon.gatewayError = new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
            code: "ECONNREFUSED",
          }),
        });
        const harness = makeHarness({ startTransport: null });

        yield* expectProviderFailure(
          connectChannel(harness.dependencies, imessageConnect(BOT_ID)),
          "ECONNREFUSED",
          "network",
        );
        expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);

        photon.gatewayError = null;
        photon.gatewayStatus = 503;
        yield* expectProviderFailure(
          connectChannel(harness.dependencies, imessageConnect(BOT_ID)),
          "503",
          "network",
        );
        expect(harness.secrets.size).toBe(0);
      }),
    );

    it.effect("shows connecting while the transport starts and records the success time", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = Promise.withResolvers<void>();
        const harness = makeHarness({
          startTransport: async () => {
            Deferred.doneUnsafe(started, Exit.void);
            await release.promise;
            return {
              externalIdentity: "@akeru",
              runtime: { post: async () => undefined, shutdown: async () => undefined },
            };
          },
        });

        const connecting = yield* connectChannel(
          harness.dependencies,
          telegramConnect(BOT_ID),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        const pending = harness.readModel().bots[0]!.channelBindings;
        expect(pending[0]).toMatchObject({ status: "connecting", lastAttemptAt: NOW });
        expect(pending[0]?.lastError).toBeUndefined();
        expect(channelBindingsForRuntime(pending)[0]?.status).toBe("connecting");

        release.resolve();
        yield* Fiber.join(connecting);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          status: "connected",
          lastSucceededAt: NOW,
        });
        expect(harness.readModel().bots[0]?.channelBindings[0]?.failureCategory).toBeUndefined();
      }),
    );

    it.effect("keeps an unconfirmed delivery warning after reconnecting", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          bots: [
            makeBot(BOT_ID, {
              channelBindings: [
                {
                  botId: BOT_ID,
                  provider: "telegram",
                  projectId: PROJECT_ID,
                  status: "failed",
                  externalIdentity: null,
                  connectedAt: null,
                  sentMessageIds: [],
                  lastError: channelFailureMessage("delivery-unknown"),
                  failureCategory: "delivery-unknown",
                },
              ],
            }),
          ],
        });

        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          status: "connected",
          lastError: channelFailureMessage("delivery-unknown"),
          failureCategory: "delivery-unknown",
        });
      }),
    );

    it.effect("keeps a running channel connected when a new token is rejected", () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-bad-token");
        const messageId = MessageId.make("message-bad-token");
        let stops = 0;
        let posts = 0;
        const harness = makeHarness({
          threads: [
            makeThread(threadId, BOT_ID, [
              makeMessage(MessageId.make("inbound-bad-token"), "user", "Question", {
                provider: "telegram",
                externalThreadId: "chat-bad-token",
              }),
              makeMessage(messageId, "assistant", "Answer"),
            ]),
          ],
          startTransport: async (input) => {
            if (input.provider === "telegram" && input.token === "invalid-token") {
              throw new Error("401 Unauthorized: invalid-token");
            }
            return {
              externalIdentity: "@akeru",
              runtime: {
                post: async () => void (posts += 1),
                shutdown: async () => void (stops += 1),
              },
            };
          },
        });
        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

        yield* expectProviderFailure(
          connectChannel(harness.dependencies, telegramConnect(BOT_ID, "invalid-token")),
          "invalid-token",
        );
        const annotated = harness.readModel().bots[0]?.channelBindings[0];
        expect(annotated).toMatchObject({
          status: "connected",
          lastError: channelFailureMessage("credentials"),
          failureCategory: "credentials",
        });
        expect(NodeUtil.inspect(annotated)).not.toContain("invalid-token");
        expect(channelBindingsForRuntime([annotated!])[0]?.status).toBe("connected");
        expect(stops).toBe(0);

        yield* sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });
        expect(posts).toBe(1);
        const cleared = harness.readModel().bots[0]?.channelBindings[0];
        expect(cleared).toMatchObject({ status: "connected", sentMessageIds: [messageId] });
        expect(cleared).not.toHaveProperty("lastError");
        expect(cleared).not.toHaveProperty("failureCategory");

        yield* expectProviderFailure(
          connectChannel(harness.dependencies, telegramConnect(BOT_ID, "invalid-token")),
          "invalid-token",
        );
        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
        const reconnected = harness.readModel().bots[0]?.channelBindings[0];
        expect(reconnected).toMatchObject({ status: "connected" });
        expect(reconnected).not.toHaveProperty("lastError");
        expect(reconnected).not.toHaveProperty("failureCategory");
      }),
    );

    it.effect("leaves no connecting binding when the bot is archived mid-connect", () =>
      Effect.gen(function* () {
        let stops = 0;
        let archiveDuringStart = (): void => undefined;
        const harness = makeHarness({
          startTransport: async () => {
            archiveDuringStart();
            return {
              externalIdentity: "@akeru",
              runtime: { post: async () => undefined, shutdown: async () => void (stops += 1) },
            };
          },
        });
        archiveDuringStart = () => harness.archive(BOT_ID);

        // A first connect that succeeds after the archive is refused and removed.
        yield* expectFailureMessage(
          connectChannel(harness.dependencies, telegramConnect(BOT_ID)),
          "Channel bot is unavailable.",
        );
        expect(stops).toBe(1);
        expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
        expect(harness.secrets.size).toBe(0);

        // A reconnect that fails after the archive puts the earlier binding back.
        const earlier: ChannelBinding = {
          botId: BOT_ID,
          projectId: PROJECT_ID,
          provider: "telegram",
          status: "connecting",
          externalIdentity: "@akeru",
          connectedAt: null,
          sentMessageIds: [],
        };
        let archiveRestarted = (): void => undefined;
        const restarted = makeHarness({
          bots: [makeBot(BOT_ID, { channelBindings: [earlier] })],
          startTransport: async () => {
            archiveRestarted();
            throw new Error("Unauthorized telegram-token");
          },
        });
        archiveRestarted = () => restarted.archive(BOT_ID);
        yield* failureOf(connectChannel(restarted.dependencies, telegramConnect(BOT_ID)));
        expect(restarted.readModel().bots[0]?.channelBindings).toEqual([
          { ...earlier, status: "needs-reconnect" },
        ]);
        expect(yield* restoreConnectedChannels(restarted.dependencies)).toEqual([]);
      }),
    );

    it.effect("reports a connecting binding with no start in flight as needing reconnect", () =>
      Effect.gen(function* () {
        const binding: ChannelBinding = {
          botId: BOT_ID,
          projectId: PROJECT_ID,
          provider: "telegram",
          status: "connecting",
          externalIdentity: null,
          connectedAt: null,
          sentMessageIds: [],
        };
        const harness = makeHarness({ bots: [makeBot(BOT_ID, { channelBindings: [binding] })] });
        yield* runWith(harness.dependencies, () => Effect.void);

        expect(channelBindingsForRuntime([binding])[0]?.status).toBe("needs-reconnect");
      }),
    );

    it.effect("pushes needs-reconnect when a live gateway exits", () =>
      Effect.gen(function* () {
        const failed = Promise.withResolvers<void>();
        const gateway = yield* startTestGateway(async (waitUntil) => {
          waitUntil(failed.promise);
          return new Response(null, { status: 200 });
        }, "Test gateway");
        const runInTest = yield* FiberSet.makeRuntimePromise();
        const stopped = yield* Deferred.make<ChannelBinding>();
        let starts = 0;
        const harness = makeHarness({
          onBindings: (bindings) => {
            if (bindings[0]?.status === "needs-reconnect") {
              Deferred.doneUnsafe(stopped, Exit.succeed(bindings[0]));
            }
          },
          // The first start runs the gateway; the reconnect gets a fresh, healthy transport.
          startTransport: async () => {
            starts += 1;
            return {
              externalIdentity: "test",
              runtime:
                starts === 1
                  ? {
                      post: async () => {},
                      shutdown: gateway.shutdown,
                      isHealthy: gateway.isHealthy,
                      settled: runInTest(gateway.settled),
                    }
                  : { post: async () => {}, shutdown: async () => {} },
            };
          },
        });
        yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));

        failed.reject(new Error("Gateway disconnected with token discord-token"));
        const binding = yield* Deferred.await(stopped);

        expect(binding).toMatchObject({
          status: "needs-reconnect",
          connectedAt: null,
          lastError: "The channel connection stopped. Reconnect to resume.",
          failureCategory: "network",
        });
        expect(NodeUtil.inspect(binding)).not.toContain("discord-token");
        yield* reconnectChannel(harness.dependencies, BOT_ID, "discord");
        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          status: "connected",
        });
        expect(harness.readModel().bots[0]?.channelBindings[0]?.lastError).toBeUndefined();
        expect(harness.readModel().bots[0]?.channelBindings[0]?.failureCategory).toBeUndefined();
      }),
    );

    it.effect("rolls back the credential when connect cannot persist the binding", () =>
      Effect.gen(function* () {
        let stops = 0;
        const harness = makeHarness({
          failBotUpdate: (index) => (index === 2 ? new Error("binding write failed") : undefined),
          shutdown: async () => void (stops += 1),
        });

        yield* expectFailureMessage(
          connectChannel(harness.dependencies, telegramConnect(BOT_ID)),
          "binding write failed",
        );

        expect(stops).toBe(1);
        expect(harness.secrets.size).toBe(0);
        expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
      }),
    );

    it.effect("rolls back an attach when the binding write fails", () =>
      Effect.gen(function* () {
        const connectionId = ChannelConnectionId.make("telegram-rollback");
        let stops = 0;
        const harness = makeHarness({
          failBotUpdate: (index) => (index === 2 ? new Error("binding write failed") : undefined),
          shutdown: async () => void (stops += 1),
        });
        yield* saveChannelConnection(harness.dependencies, {
          type: "channel.connection.save",
          commandId: CommandId.make("save-rollback"),
          connectionId,
          name: "Rollback Telegram",
          provider: "telegram",
          token: "telegram-token",
        });
        const saved = [...harness.secrets.entries()];

        yield* expectFailureMessage(
          attachChannelConnection(
            harness.dependencies,
            BOT_ID,
            connectionId,
            PROJECT_ID,
            "telegram",
          ),
          "binding write failed",
        );

        expect(stops).toBe(1);
        expect([...harness.secrets.entries()]).toEqual(saved);
        // The chosen bot stays on the saved connection so the user can retry from the row.
        expect(harness.readModel().bots[0]?.channelBindings).toEqual([
          expect.objectContaining({ connectionId, status: "failed", projectId: PROJECT_ID }),
        ]);
        yield* detachChannelConnection(harness.dependencies, BOT_ID, "telegram");
        yield* deleteChannelConnection(harness.dependencies, connectionId);
        expect(harness.secrets.size).toBe(0);
      }),
    );

    const rejectedAttachSaves = [
      { provider: "telegram", token: "telegram-token" },
      { provider: "slack", botToken: "xoxb-token", appToken: "xapp-token" },
      {
        provider: "discord",
        applicationId: "123456789012345678",
        publicKey: "a".repeat(64),
        botToken: "discord-token",
      },
    ] as const;
    for (const credentials of rejectedAttachSaves) {
      it.effect(
        `keeps the chosen bot on a ${credentials.provider} connection it could not attach`,
        () =>
          Effect.gen(function* () {
            const connectionId = ChannelConnectionId.make(`${credentials.provider}-rejected`);
            let rejected = true;
            const harness = makeHarness({
              startTransport: async () => {
                if (rejected) throw new Error("401 Unauthorized");
                return {
                  externalIdentity: "@akeru",
                  runtime: { post: async () => undefined, shutdown: async () => undefined },
                };
              },
            });
            yield* saveChannelConnection(harness.dependencies, {
              type: "channel.connection.save",
              commandId: CommandId.make(`save-${credentials.provider}-rejected`),
              connectionId,
              name: "Rejected line",
              ...credentials,
            });

            yield* expectProviderFailure(
              attachChannelConnection(
                harness.dependencies,
                BOT_ID,
                connectionId,
                PROJECT_ID,
                credentials.provider,
              ),
              "401 Unauthorized",
            );

            expect(harness.readModel().bots[0]?.channelBindings).toEqual([
              expect.objectContaining({
                connectionId,
                projectId: PROJECT_ID,
                status: "failed",
                connectedAt: null,
                failureCategory: "credentials",
              }),
            ]);

            rejected = false;
            yield* reconnectChannel(harness.dependencies, BOT_ID, credentials.provider);
            expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
              connectionId,
              status: "connected",
            });
            expect(
              harness.readModel().bots[0]?.channelBindings[0]?.failureCategory,
            ).toBeUndefined();
            yield* stopChannelsForBot(BOT_ID);
          }),
      );
    }

    it.effect("keeps the live transport when a second bot claims its identity", () =>
      Effect.gen(function* () {
        const secondId = BotId.make("bot-2");
        const stops: string[] = [];
        const harness = makeHarness({
          bots: [makeBot(BOT_ID), makeBot(secondId)],
          startTransport: async (input) => ({
            externalIdentity: "@akeru",
            runtime: {
              post: async () => undefined,
              shutdown: async () => void stops.push(input.botId),
            },
          }),
        });
        yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));

        yield* expectFailureMessage(
          connectChannel(harness.dependencies, telegramConnect(secondId)),
          "already connected",
        );

        expect(stops).not.toContain(BOT_ID);
        const [first, second] = harness.readModel().bots;
        expect(first?.channelBindings[0]).toMatchObject({ status: "connected" });
        expect(channelBindingsForRuntime(first!.channelBindings)[0]?.status).toBe("connected");
        expect(second?.channelBindings).toEqual([]);
        expect(harness.secrets.size).toBe(1);
      }),
    );

    it.effect("records the restore category when a restored transport cannot start", () =>
      Effect.gen(function* () {
        const binding: ChannelBinding = {
          botId: BOT_ID,
          projectId: PROJECT_ID,
          provider: "telegram",
          status: "connected",
          externalIdentity: "@akeru",
          connectedAt: NOW,
          sentMessageIds: [],
        };
        const harness = makeHarness({
          bots: [makeBot(BOT_ID, { channelBindings: [binding] })],
          startTransport: async () => {
            throw new Error("401 Unauthorized for token telegram-token");
          },
        });

        const failures = yield* restoreConnectedChannels(harness.dependencies);

        expect(failures).toEqual([{ botId: BOT_ID, provider: "telegram", category: "restore" }]);
        const restored = harness.readModel().bots[0]?.channelBindings[0];
        expect(restored).toMatchObject({
          status: "failed",
          connectedAt: null,
          failureCategory: "restore",
        });
        expect(NodeUtil.inspect(restored)).not.toContain("telegram-token");
        expect(NodeUtil.inspect(restored)).not.toContain("Unauthorized");
      }),
    );
  });
});
