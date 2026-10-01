import {
  expectFailureMessage,
  expectProviderFailure,
  saveChannelConnection,
  attachChannelConnection,
  changeChannelProject,
  dispatchInboundChannelMessage,
  stopChannelsForBot,
  shutdownAllChannels,
  NOW,
  BOT_ID,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  MISSING_PROJECT_ID,
  makeBot,
  makeHarness,
} from "./testUtils/channelRuntime.ts";
import * as NodeCrypto from "node:crypto";
import { ChannelConnectionId, CommandId, ProjectId, type ChannelBinding } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { type ChannelRuntimeDependencies } from "./ChannelRuntime.ts";

describe("channel runtime", () => {
  it.effect("attaches to the project the client names", () =>
    Effect.gen(function* () {
      const connectionId = ChannelConnectionId.make("channel-default-project");

      const harness = makeHarness({
        startTransport: async () => ({
          externalIdentity: "@bot",
          runtime: { post: async () => {}, shutdown: async () => {} },
        }),
      });

      yield* saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("save-default-project"),
        connectionId,
        name: "Default project line",
        provider: "telegram",
        token: "telegram-token",
      });

      yield* attachChannelConnection(
        harness.dependencies,
        BOT_ID,
        connectionId,
        PROJECT_ID,
        "telegram",
      );

      expect(harness.readModel().bots[0]?.channelBindings?.[0]).toMatchObject({
        connectionId,
        status: "connected",
        projectId: PROJECT_ID,
      });
    }),
  );

  it.effect("blocks the binding when its selected project is unavailable", () =>
    Effect.gen(function* () {
      const binding: ChannelBinding = {
        botId: BOT_ID,
        projectId: MISSING_PROJECT_ID,
        provider: "telegram",
        status: "connected",
        externalIdentity: "@akeru",
        connectedAt: NOW,
        sentMessageIds: [],
      };

      const harness = makeHarness({ bots: [makeBot(BOT_ID, { channelBindings: [binding] })] });

      yield* expectFailureMessage(
        dispatchInboundChannelMessage(harness.dependencies, {
          botId: BOT_ID,
          projectId: MISSING_PROJECT_ID,
          provider: "telegram",
          externalThreadId: "chat-missing-project",
          externalMessageId: "message-missing-project",
          text: "Work",
        }),
        "project is unavailable",
      );
      expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
        status: "blocked",
        lastError: "The selected project is unavailable. Choose another project.",
      });
    }),
  );

  describe("changeChannelProject", () => {
    const changeProjectConnectionId = ChannelConnectionId.make("telegram-change-project");

    const saveConnection = (harness: ReturnType<typeof makeHarness>) =>
      saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("save-change-project"),
        connectionId: changeProjectConnectionId,
        name: "Change project line",
        provider: "telegram",
        token: "telegram-token",
      });

    // Legacy per-bot credentials let a test seed a binding before any connection exists.
    const seedLegacySecret = (harness: ReturnType<typeof makeHarness>) =>
      harness.secrets.set(
        `channel-telegram-${NodeCrypto.createHash("sha256").update(BOT_ID).digest("hex")}`,
        new TextEncoder().encode(JSON.stringify({ provider: "telegram", token: "telegram-token" })),
      );

    const legacyBindingOn = (
      projectId: ProjectId,
      status: ChannelBinding["status"],
    ): ChannelBinding => ({
      botId: BOT_ID,
      projectId,
      provider: "telegram",
      status,
      externalIdentity: "@akeru",
      connectedAt: status === "connected" ? NOW : null,
      sentMessageIds: [],
    });

    it.effect("moves a blocked binding to a live project and reconnects it", () =>
      Effect.gen(function* () {
        const starts: Array<ProjectId> = [];

        const harness = makeHarness({
          bots: [
            makeBot(BOT_ID, {
              channelBindings: [
                {
                  ...legacyBindingOn(MISSING_PROJECT_ID, "blocked"),
                  lastError: "The selected project is unavailable. Choose another project.",
                },
              ],
            }),
          ],
          startTransport: async (input) => {
            starts.push(input.targetProjectId);

            return {
              externalIdentity: "@akeru",
              runtime: { post: async () => undefined, shutdown: async () => undefined },
            };
          },
        });

        seedLegacySecret(harness);

        yield* changeChannelProject(harness.dependencies, BOT_ID, "telegram", SECOND_PROJECT_ID);

        expect(starts).toEqual([SECOND_PROJECT_ID]);
        const binding = harness.readModel().bots[0]?.channelBindings[0];
        expect(binding).toMatchObject({
          projectId: SECOND_PROJECT_ID,
          status: "connected",
        });
        expect(binding?.lastError).toBeUndefined();
      }),
    );

    it.effect("moves a disconnected binding without reconnecting it", () =>
      Effect.gen(function* () {
        const starts: Array<ProjectId> = [];

        const harness = makeHarness({
          bots: [
            makeBot(BOT_ID, { channelBindings: [legacyBindingOn(PROJECT_ID, "disconnected")] }),
          ],
          startTransport: async (input) => {
            starts.push(input.targetProjectId);

            return {
              externalIdentity: "@akeru",
              runtime: { post: async () => undefined, shutdown: async () => undefined },
            };
          },
        });

        seedLegacySecret(harness);

        yield* changeChannelProject(harness.dependencies, BOT_ID, "telegram", SECOND_PROJECT_ID);

        expect(starts).toEqual([]);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          projectId: SECOND_PROJECT_ID,
          status: "disconnected",
        });
      }),
    );

    it.effect("rejects an unavailable target without touching the running channel", () =>
      Effect.gen(function* () {
        let stops = 0;
        const harness = makeHarness({ shutdown: async () => void (stops += 1) });
        yield* saveConnection(harness);
        yield* attachChannelConnection(
          harness.dependencies,
          BOT_ID,
          changeProjectConnectionId,
          PROJECT_ID,
          "telegram",
        );
        const before = harness.readModel().bots[0]?.channelBindings[0];

        yield* expectFailureMessage(
          changeChannelProject(harness.dependencies, BOT_ID, "telegram", MISSING_PROJECT_ID),
          "The selected project is unavailable. Choose another project.",
        );

        expect(stops).toBe(0);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toEqual(before);
        yield* stopChannelsForBot(BOT_ID);
      }),
    );

    it.effect("leaves a running channel alone when the target is its current project", () =>
      Effect.gen(function* () {
        let stops = 0;
        const harness = makeHarness({ shutdown: async () => void (stops += 1) });
        yield* saveConnection(harness);
        yield* attachChannelConnection(
          harness.dependencies,
          BOT_ID,
          changeProjectConnectionId,
          PROJECT_ID,
          "telegram",
        );
        const before = harness.readModel().bots[0]?.channelBindings[0];

        yield* changeChannelProject(harness.dependencies, BOT_ID, "telegram", PROJECT_ID);

        expect(stops).toBe(0);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toEqual(before);
        yield* stopChannelsForBot(BOT_ID);
      }),
    );

    it.effect("rejects missing credentials without stopping the running channel", () =>
      Effect.gen(function* () {
        let stops = 0;
        const harness = makeHarness({ shutdown: async () => void (stops += 1) });
        yield* saveConnection(harness);
        yield* attachChannelConnection(
          harness.dependencies,
          BOT_ID,
          changeProjectConnectionId,
          PROJECT_ID,
          "telegram",
        );
        harness.secrets.clear();

        yield* expectFailureMessage(
          changeChannelProject(harness.dependencies, BOT_ID, "telegram", SECOND_PROJECT_ID),
          "No saved telegram credentials.",
        );

        expect(stops).toBe(0);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          projectId: PROJECT_ID,
          status: "connected",
        });
        yield* stopChannelsForBot(BOT_ID);
      }),
    );

    it.effect("keeps the previous project when the new runtime fails after the old one stops", () =>
      Effect.gen(function* () {
        const events: Array<string> = [];

        const harness = makeHarness({
          startTransport: async (input) => {
            if (input.targetProjectId === SECOND_PROJECT_ID) {
              events.push(`fail:${input.targetProjectId}`);
              throw new Error("transport refused");
            }

            events.push(`start:${input.targetProjectId}`);

            return {
              externalIdentity: "@akeru",
              runtime: {
                post: async () => undefined,
                shutdown: async () => void events.push(`stop:${input.targetProjectId}`),
              },
            };
          },
        });

        yield* saveConnection(harness);
        yield* attachChannelConnection(
          harness.dependencies,
          BOT_ID,
          changeProjectConnectionId,
          PROJECT_ID,
          "telegram",
        );

        yield* expectProviderFailure(
          changeChannelProject(harness.dependencies, BOT_ID, "telegram", SECOND_PROJECT_ID),
          "transport refused",
        );

        expect(events).toEqual([
          `start:${PROJECT_ID}`,
          `stop:${PROJECT_ID}`,
          `fail:${SECOND_PROJECT_ID}`,
          `start:${PROJECT_ID}`,
        ]);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          projectId: PROJECT_ID,
          status: "connected",
        });
        yield* stopChannelsForBot(BOT_ID);
      }),
    );

    it.effect("keeps the old listener reachable when shutdown prevents a project move", () =>
      Effect.gen(function* () {
        const events: Array<string> = [];

        const callbacks: Array<
          Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1]
        > = [];

        let shutdownFails = true;

        const harness = makeHarness({
          startTransport: async (input, onDirectMessage) => {
            events.push(`start:${input.targetProjectId}`);
            callbacks.push(onDirectMessage);

            return {
              externalIdentity: "@akeru",
              runtime: {
                post: async () => undefined,
                shutdown: async () => {
                  events.push(`stop:${input.targetProjectId}`);

                  if (shutdownFails) throw new Error("shutdown failed");
                },
              },
            };
          },
        });

        yield* saveConnection(harness);
        yield* attachChannelConnection(
          harness.dependencies,
          BOT_ID,
          changeProjectConnectionId,
          PROJECT_ID,
          "telegram",
        );
        const before = harness.readModel().bots[0]?.channelBindings[0];
        const sequenceBefore = harness.readModel().snapshotSequence;

        yield* expectFailureMessage(
          changeChannelProject(harness.dependencies, BOT_ID, "telegram", SECOND_PROJECT_ID),
          "Channel provider request failed.",
        );

        expect(events).toEqual([`start:${PROJECT_ID}`, `stop:${PROJECT_ID}`]);
        expect(harness.readModel().bots[0]?.channelBindings[0]).toEqual(before);
        expect(harness.readModel().snapshotSequence).toBe(sequenceBefore);

        const message = {
          externalThreadId: "telegram:failed-project-move",
          externalMessageId: "still-reachable",
          text: "Use the original project",
        };

        yield* Effect.promise(async () => callbacks[0]?.(message));
        expect(
          harness.commands.filter((command) => command.type === "thread.turn.start"),
        ).toHaveLength(1);
        expect(harness.readModel().threads[0]?.projectId).toBe(PROJECT_ID);

        shutdownFails = false;
        yield* shutdownAllChannels();
        expect(events).toEqual([`start:${PROJECT_ID}`, `stop:${PROJECT_ID}`, `stop:${PROJECT_ID}`]);
        yield* Effect.promise(async () =>
          callbacks[0]?.({ ...message, externalMessageId: "after-shutdown" }),
        );
        expect(
          harness.commands.filter((command) => command.type === "thread.turn.start"),
        ).toHaveLength(1);
        yield* shutdownAllChannels();
        expect(events).toHaveLength(3);
      }),
    );

    it.effect("records a failure on the previous project when neither runtime starts", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          bots: [
            makeBot(BOT_ID, {
              channelBindings: [legacyBindingOn(MISSING_PROJECT_ID, "blocked")],
            }),
          ],
          startTransport: async () => {
            throw new Error("transport refused");
          },
        });

        seedLegacySecret(harness);

        yield* expectProviderFailure(
          changeChannelProject(harness.dependencies, BOT_ID, "telegram", SECOND_PROJECT_ID),
          "transport refused",
        );

        expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
          projectId: MISSING_PROJECT_ID,
          status: "blocked",
          connectedAt: null,
          lastError: "Could not start the channel in the selected project. Try again.",
        });
      }),
    );
  });
});
