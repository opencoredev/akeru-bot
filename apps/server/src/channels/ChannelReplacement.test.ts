import { executeChannelCommand } from "./ChannelCommand.ts";
import { ChannelConnectionId, CommandId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  channelRuntimeFor,
  BOT_ID,
  PROJECT_ID,
  makeHarness,
  slackConnect,
  saveChannelConnection,
  attachChannelConnection,
  detachChannelConnection,
  disconnectChannel,
  expectFailureMessage,
} from "./testUtils/channelRuntime.ts";

const oldId = ChannelConnectionId.make("slack-old");

const newId = ChannelConnectionId.make("slack-new");

const concurrentId = ChannelConnectionId.make("slack-concurrent");

const unassignFirst = "Unassign the channel already connected to this bot first";

describe("channel credential replacement lifecycle", () => {
  for (const disconnected of [false, true]) {
    it.effect(
      `restores old credentials after a failed replacement (${disconnected ? "disconnected" : "connected"})`,
      () =>
        Effect.gen(function* () {
          const starts: string[] = [];
          const stops: string[] = [];

          const harness = makeHarness({
            startTransport: async (input) => {
              if (input.provider !== "slack") throw new Error("Expected Slack");
              starts.push(input.botToken);

              if (input.botToken === newId) throw new Error("invalid_auth");

              return {
                externalIdentity: input.botToken,
                runtime: {
                  post: async () => undefined,
                  shutdown: async () => void stops.push(input.botToken),
                },
              };
            },
          });

          for (const connectionId of [oldId, newId, concurrentId]) {
            yield* saveChannelConnection(harness.dependencies, {
              ...slackConnect(BOT_ID),
              type: "channel.connection.save",
              connectionId,
              name: connectionId,
              botToken: connectionId,
            });
          }

          yield* attachChannelConnection(harness.dependencies, BOT_ID, oldId, PROJECT_ID, "slack");

          if (disconnected) yield* disconnectChannel(harness.dependencies, BOT_ID, "slack");
          yield* detachChannelConnection(harness.dependencies, BOT_ID, "slack", oldId);
          yield* expectFailureMessage(
            attachChannelConnection(harness.dependencies, BOT_ID, newId, PROJECT_ID, "slack"),
            "Channel provider request failed.",
          );
          expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
            connectionId: newId,
            status: "failed",
          });

          // A failed assignment remains owned until explicitly released, including during rollback.
          for (const connectionId of [oldId, concurrentId]) {
            yield* expectFailureMessage(
              attachChannelConnection(
                harness.dependencies,
                BOT_ID,
                connectionId,
                PROJECT_ID,
                "slack",
              ),
              unassignFirst,
            );
          }

          yield* detachChannelConnection(harness.dependencies, BOT_ID, "slack", newId);
          yield* attachChannelConnection(harness.dependencies, BOT_ID, oldId, PROJECT_ID, "slack");

          if (disconnected) yield* disconnectChannel(harness.dependencies, BOT_ID, "slack");
          expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
            connectionId: oldId,
            projectId: PROJECT_ID,
            status: disconnected ? "disconnected" : "connected",
          });
          expect(starts).toEqual([oldId, newId, oldId]);
          expect(stops).toEqual(disconnected ? [oldId, oldId] : [oldId]);
          expect(harness.secrets.size).toBe(3);
        }),
    );
  }

  it.effect("does not detach a different assignment that won the rollback race", () =>
    Effect.gen(function* () {
      let stops = 0;
      const harness = makeHarness({ shutdown: async () => void (stops += 1) });
      yield* saveChannelConnection(harness.dependencies, {
        ...slackConnect(BOT_ID),
        type: "channel.connection.save",
        connectionId: concurrentId,
        name: "Concurrent Slack",
      });
      yield* attachChannelConnection(
        harness.dependencies,
        BOT_ID,
        concurrentId,
        PROJECT_ID,
        "slack",
      );
      const before = harness.readModel().bots[0]?.channelBindings[0];
      const commands = harness.commands.length;
      const runtime = yield* channelRuntimeFor(harness.dependencies);

      yield* expectFailureMessage(
        executeChannelCommand(runtime, {
          type: "channel.detach",
          commandId: CommandId.make("rollback-detach"),
          botId: BOT_ID,
          provider: "slack",
          expectedConnectionId: newId,
        }),
        unassignFirst,
      );
      expect(harness.readModel().bots[0]?.channelBindings[0]).toEqual(before);
      expect(harness.commands).toHaveLength(commands);
      expect(stops).toBe(0);
    }),
  );

  it.effect("allows rollback after an attach rejection that never assigned the replacement", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});
      yield* saveChannelConnection(harness.dependencies, {
        ...slackConnect(BOT_ID),
        type: "channel.connection.save",
        connectionId: oldId,
        name: "Old Slack",
      });
      yield* attachChannelConnection(harness.dependencies, BOT_ID, oldId, PROJECT_ID, "slack");
      yield* detachChannelConnection(harness.dependencies, BOT_ID, "slack", oldId);
      const commands = harness.commands.length;
      yield* expectFailureMessage(
        attachChannelConnection(harness.dependencies, BOT_ID, newId, PROJECT_ID, "slack"),
        "unavailable",
      );
      yield* detachChannelConnection(harness.dependencies, BOT_ID, "slack", newId);
      expect(harness.commands).toHaveLength(commands);
      yield* attachChannelConnection(harness.dependencies, BOT_ID, oldId, PROJECT_ID, "slack");
      expect(harness.readModel().bots[0]?.channelBindings[0]?.connectionId).toBe(oldId);
    }),
  );
});
