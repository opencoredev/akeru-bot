import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { NOW, makeReadModel, createSession } from "./test-support/SettledDeciderFixtures.ts";

it.layer(NodeServices.layer)("settled thread decider", (it) => {
  it.effect("prepends activity unsets for turn starts and live session updates", () =>
    Effect.gen(function* () {
      const turnResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const turnEvents = Array.isArray(turnResult) ? turnResult : [turnResult];
      expect(turnEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);

      const sessionResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set"),
          threadId: ThreadId.make("thread-1"),
          session: createSession("running"),
          createdAt: NOW,
        },
        // A keep-active state is also an override. Real activity clears it
        // back to neutral.
        readModel: makeReadModel("active"),
      });
      const sessionEvents = Array.isArray(sessionResult) ? sessionResult : [sessionResult];
      expect(sessionEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.session-set",
      ]);
    }),
  );

  it.effect("clears a keep-active pin on real activity", () =>
    Effect.gen(function* () {
      const turnResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-active-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-active"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel("active"),
      });
      const turnEvents = Array.isArray(turnResult) ? turnResult : [turnResult];
      // Activity resets the active override to neutral.
      expect(turnEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);

      const activityResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-active-approval"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-active"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("active"),
      });
      const activityEvents = Array.isArray(activityResult) ? activityResult : [activityResult];
      expect(activityEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.activity-appended",
      ]);
    }),
  );

  it.effect("unsettles for a memory approval request", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-memory-approval"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-memory-approval"),
            tone: "approval",
            kind: "memory.approval.requested",
            summary: "Save to project memory?",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.activity-appended",
      ]);
    }),
  );

  it.effect("does not unsettle for session stop/error status writes", () =>
    Effect.gen(function* () {
      for (const status of ["stopped", "error", "ready", "idle"] as const) {
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-session-${status}`),
            threadId: ThreadId.make("thread-1"),
            session: createSession(status),
            createdAt: NOW,
          },
          readModel: makeReadModel("settled"),
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
      }
    }),
  );

  it.effect("unsettles for approval and user-input activities but not others", () =>
    Effect.gen(function* () {
      const approvalResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-activity-approval"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-1"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const approvalEvents = Array.isArray(approvalResult) ? approvalResult : [approvalResult];
      expect(approvalEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.activity-appended",
      ]);

      const routineResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-activity-routine"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-2"),
            tone: "info",
            kind: "tool.completed",
            summary: "Tool completed",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const routineEvents = Array.isArray(routineResult) ? routineResult : [routineResult];
      expect(routineEvents.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    }),
  );

  it.effect("drops an onlyIfSettled session stop when the thread was re-engaged", () =>
    Effect.gen(function* () {
      const stopCommand = (commandId: string) =>
        ({
          type: "thread.session.stop",
          commandId: CommandId.make(commandId),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
          onlyIfSettled: true,
        }) as const;

      // Still settled with an idle session: the cleanup stop goes through.
      const stopped = yield* decideOrchestrationCommand({
        command: stopCommand("cmd-stop-settled-idle"),
        readModel: makeReadModel("settled", null, createSession("ready")),
      });
      const stoppedEvents = Array.isArray(stopped) ? stopped : [stopped];
      expect(stoppedEvents.map((event) => event.type)).toEqual(["thread.session-stop-requested"]);

      // Re-engaged before the stop was decided (a turn start unsettles the
      // thread): the stale cleanup stop must not kill the new session.
      const unsettledError = yield* decideOrchestrationCommand({
        command: stopCommand("cmd-stop-unsettled"),
        readModel: makeReadModel(null, null, createSession("starting")),
      }).pipe(Effect.flip);
      expect(unsettledError._tag).toBe("OrchestrationCommandInvariantError");

      // Still settled but the session is already coming alive: same drop.
      const aliveError = yield* decideOrchestrationCommand({
        command: stopCommand("cmd-stop-session-alive"),
        readModel: makeReadModel("settled", null, createSession("starting")),
      }).pipe(Effect.flip);
      expect(aliveError._tag).toBe("OrchestrationCommandInvariantError");

      // Without the flag the stop stays unconditional (archive, stop button).
      const unconditional = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-stop-unconditional"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel(null, null, createSession("starting")),
      });
      const unconditionalEvents = Array.isArray(unconditional) ? unconditional : [unconditional];
      expect(unconditionalEvents.map((event) => event.type)).toEqual([
        "thread.session-stop-requested",
      ]);
    }),
  );

  it.layer(NodeServices.layer)("memory observation drop activity", (it) => {
    it.effect("projects a dropped-observation activity row with thread and turn context", () =>
      Effect.gen(function* () {
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.activity.append",
            commandId: CommandId.make("cmd-observation-dropped"),
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("observation-dropped-1"),
              tone: "error",
              kind: "memory.observation.dropped",
              summary: "Background memory observation dropped after repeated failures",
              payload: {
                resourceId: "thread-1",
                modelId: "openai/gpt-5.6-sol",
                attempts: 3,
                detail: "observer down",
              },
              turnId: TurnId.make("turn-1"),
              createdAt: NOW,
            },
            createdAt: NOW,
          },
          readModel: makeReadModel(null),
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);

        const appended = events[0]!;
        assert.equal(appended.type, "thread.activity-appended");
        const projected = yield* projectEvent(makeReadModel(null), {
          ...appended,
          sequence: 1,
        } as OrchestrationEvent).pipe(Effect.orDie);
        const activity = projected.threads[0]?.activities[0];
        expect(activity?.kind).toBe("memory.observation.dropped");
        expect(activity?.tone).toBe("error");
        expect(activity?.turnId).toBe("turn-1");
        expect(activity?.summary).toBe(
          "Background memory observation dropped after repeated failures",
        );
        expect(activity?.payload).toMatchObject({ attempts: 3, detail: "observer down" });
      }),
    );
  });
});
