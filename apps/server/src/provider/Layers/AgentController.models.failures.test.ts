// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, describe, expect } from "vite-plus/test";
import { AgentController } from "../Services/AgentController.ts";
import { recordProviderAccessHealth } from "./AgentController.ts";
import { makeTestSubscriptionAuthService } from "../../subscription-auth/testUtils/subscriptionAuthService.ts";
import {
  codexThreadId,
  claudeThreadId,
  grokThreadId,
  kimiThreadId,
  codexInstanceId,
  claudeInstanceId,
  grokInstanceId,
  kimiInstanceId,
  codexSelection,
  instanceModelCatalog,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
  switchCases,
  kimiStartInput,
  resolveKimi,
} from "./test-support/agentControllerLayers.ts";
import { makeMastraHarness, assistantMessage } from "./test-support/agentControllerHarness.ts";

describe("provider access health", () => {
  it("records the model a failed turn ran on with the instance failure", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-access-model-"));
    try {
      const service = await makeTestSubscriptionAuthService(
        NodePath.join(directory, "subscription-auth.json"),
      );
      recordProviderAccessHealth(
        service,
        {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId: ThreadId.make("thread-model"),
          turnId: TurnId.make("turn-model"),
          type: "turn.completed",
          eventId: EventId.make("evt-model-failed"),
          createdAt: "2026-08-30T20:00:00.000Z",
          payload: { state: "failed", stopReason: null, errorMessage: "Model gpt-typo not found" },
        },
        "gpt-typo",
      );

      expect(service.providerInstanceRequestHealth("codex")?.lastFailedRequest).toEqual({
        at: "2026-08-30T20:00:00.000Z",
        message: "Model gpt-typo not found",
        model: "gpt-typo",
      });
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("AgentControllerLive", () => {
  it.effect("runs Codex turns through Mastra Session.sendMessage and normalizes events", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        const session = yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
        });
        assert.equal(session.provider, "codex");

        const events: ProviderRuntimeEvent[] = [];
        const eventsFiber = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        yield* controller.sendTurn({ threadId: codexThreadId, input: "Reply once." });
        mastra.emit({
          type: "message_update",
          message: assistantMessage("Mastra"),
        } as AgentControllerEvent);
        mastra.emit({
          type: "message_end",
          message: assistantMessage("Mastra answer"),
        } as AgentControllerEvent);
        mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastra.finishSend();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(eventsFiber);

        assert.deepEqual(
          events.slice(0, 6).map((event) => event.type),
          [
            "turn.started",
            "session.state.changed",
            "item.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );
        assert.equal(
          events
            .flatMap((event) => (event.type === "content.delta" ? [event.payload.delta] : []))
            .join(""),
          "Mastra answer",
        );
        expect(mastra.sendMessage).toHaveBeenCalledWith({ content: "Reply once." });
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.sendTurn).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("normalizes legacy plan input when running Claude through Mastra", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        const resolved = yield* controller.resolveEngine({
          threadId: claudeThreadId,
          engine: { provider: "claudeAgent", model: "claude-fable-5" },
          fallback: codexSelection,
          mode: "plan",
          botConversation: true,
        });
        assert.equal(resolved.mode, "default");
        yield* controller.startSession(claudeThreadId, {
          threadId: claudeThreadId,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const result = yield* controller.sendTurn({
          threadId: claudeThreadId,
          input: "Use Claude.",
        });

        expect(String(result.turnId)).toMatch(/^mastra-turn-/);
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.sendTurn).not.toHaveBeenCalled();
        expect(mastra.createSession).toHaveBeenCalledOnce();
        expect(mastra.session.model.switch).toHaveBeenCalledWith({
          modelId: "anthropic/claude-fable-5",
        });
        expect(mastra.session.mode.switch).not.toHaveBeenCalledWith({ modeId: "plan" });
        expect(mastra.sendMessage).toHaveBeenCalledOnce();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("runs Grok through the Akeru Mastra harness", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: grokThreadId,
          engine: { provider: "grok", model: "grok-code-fast-1" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* controller.startSession(grokThreadId, {
          threadId: grokThreadId,
          provider: ProviderDriverKind.make("grok"),
          providerInstanceId: grokInstanceId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const result = yield* controller.sendTurn({
          threadId: grokThreadId,
          input: "Use Grok.",
        });

        expect(String(result.turnId)).toMatch(/^mastra-turn-/);
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.sendTurn).not.toHaveBeenCalled();
        expect(mastra.createSession).toHaveBeenCalledOnce();
        expect(mastra.session.model.switch).toHaveBeenCalledWith({
          modelId: "xai/grok-code-fast-1",
        });
        expect(mastra.sendMessage).toHaveBeenCalledOnce();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  it.effect("runs the saved Kimi model through Mastra without provider fallback", () => {
    const bridge = makeBridge();
    const mastra = makeMastraHarness();
    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* controller.resolveEngine({
          threadId: kimiThreadId,
          engine: { provider: String(kimiInstanceId), model: "k3-256k" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        const session = yield* controller.startSession(kimiThreadId, {
          threadId: kimiThreadId,
          provider: ProviderDriverKind.make("kimi"),
          providerInstanceId: kimiInstanceId,
          cwd: process.cwd(),
          modelSelection: { instanceId: kimiInstanceId, model: "k3-256k" },
          runtimeMode: "approval-required",
        });

        assert.equal(session.provider, "kimi");
        assert.equal(session.model, "k3-256k");
        expect(mastra.session.model.switch).toHaveBeenCalledWith({
          modelId: "kimi-for-coding/k3-256k",
        });
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.getCapabilities).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  describe("in-session model switch between turns", () => {
    for (const testCase of switchCases) {
      it.effect(
        `switches the saved ${testCase.provider} model in-session between turns via resolveEngine`,
        () => {
          const bridge = makeBridge();
          const mastra = makeMastraHarness();
          const model = (model: string) => ({
            instanceId: testCase.instanceId,
            model,
          });
          return provideController(
            Effect.gen(function* () {
              const controller = yield* AgentController;
              const resolve = (model: string) =>
                controller.resolveEngine({
                  threadId: testCase.threadId,
                  engine: { provider: String(testCase.instanceId), model },
                  fallback: codexSelection,
                  mode: "default",
                  botConversation: true,
                });
              yield* resolve(testCase.from);
              yield* controller.startSession(testCase.threadId, {
                threadId: testCase.threadId,
                provider: ProviderDriverKind.make(testCase.provider),
                providerInstanceId: testCase.instanceId,
                cwd: process.cwd(),
                modelSelection: model(testCase.from),
                runtimeMode: "approval-required",
              });
              yield* controller.sendTurn({
                threadId: testCase.threadId,
                input: "First turn.",
              });
              yield* Effect.yieldNow;
              mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
              mastra.finishSend();
              yield* Effect.yieldNow;
              expect(mastra.session.model.switch).toHaveBeenCalledWith({
                modelId: `${testCase.wirePrefix}/${testCase.from}`,
              });

              yield* resolve(testCase.to);
              expect(mastra.session.model.switch).toHaveBeenCalledWith({
                modelId: `${testCase.wirePrefix}/${testCase.to}`,
              });
              expect(mastra.createSession).toHaveBeenCalledOnce();

              const completed = yield* controller.streamEvents.pipe(
                Stream.filter((event) => event.type === "turn.completed"),
                Stream.runHead,
                Effect.forkChild({ startImmediately: true }),
              );
              yield* controller.sendTurn({
                threadId: testCase.threadId,
                input: "Second turn.",
                modelSelection: model(testCase.to),
              });
              yield* Effect.yieldNow;
              mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
              mastra.finishSend();
              assert.equal((yield* Fiber.join(completed))._tag, "Some");

              const [session] = yield* controller.listSessions();
              assert.equal(session?.model, testCase.to);
              expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, {
                content: "Second turn.",
              });
              expect(bridge.sendTurn).not.toHaveBeenCalled();
            }),
            bridge.service,
            mastra.factory,
          );
        },
      );
    }
  });
});

describe("AgentControllerLive", () => {
  describe("in-session model switch between turns", () => {
    it.effect("fails closed when the saved model is not in the instance snapshot", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      instanceModelCatalog.set(String(codexInstanceId), { models: ["gpt-5.6-sol"] });
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const failure = yield* Effect.flip(
            controller.resolveEngine({
              threadId: codexThreadId,
              engine: { provider: "codex", model: "not-a-model" },
              fallback: codexSelection,
              mode: "default",
              botConversation: true,
            }),
          );
          assert.equal(failure._tag, "AgentControllerUnsupportedEngineError");
          if (failure._tag === "AgentControllerUnsupportedEngineError") {
            assert.include(failure.detail, "Model 'not-a-model' is not available for codex.");
          }
          expect(mastra.createSession).not.toHaveBeenCalled();
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("in-session model switch between turns", () => {
    it.effect("allows a saved model advertised through the instance snapshot", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      instanceModelCatalog.set(String(codexInstanceId), {
        models: ["gpt-5.6-sol", "custom-codex"],
      });
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const resolved = yield* controller.resolveEngine({
            threadId: codexThreadId,
            engine: { provider: "codex", model: "custom-codex" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          assert.equal(resolved.modelSelection.model, "custom-codex");
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("in-session model switch between turns", () => {
    it.effect("does not fail closed on a pending snapshot's model list", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      // A pending probe still advertises the built-in catalog. The saved model
      // may be real but only show up once the probe finishes, so the check
      // must not reject it.
      instanceModelCatalog.set(String(codexInstanceId), {
        models: ["gpt-5.6-sol"],
        status: "warning",
      });
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          const resolved = yield* controller.resolveEngine({
            threadId: codexThreadId,
            engine: { provider: "codex", model: "cli-only-model" },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });
          assert.equal(resolved.modelSelection.model, "cli-only-model");
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("Kimi Mastra normalization", () => {
    it.effect("normalizes a full Kimi turn with a tool call over the Mastra session", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* resolveKimi(controller);
          yield* controller.startSession(kimiThreadId, kimiStartInput("k3-256k"));

          const events: ProviderRuntimeEvent[] = [];
          const eventsFiber = yield* controller.streamEvents.pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            Effect.forkChild({ startImmediately: true }),
          );
          const completed = yield* controller.streamEvents.pipe(
            Stream.filter(
              (event) => event.type === "turn.completed" && event.payload.state === "completed",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Effect.yieldNow;

          yield* controller.sendTurn({ threadId: kimiThreadId, input: "Read this file." });
          yield* Effect.yieldNow;
          mastra.emit({
            type: "tool_start",
            toolCallId: "read-1",
            toolName: "read_file",
            args: { path: "README.md" },
          } as AgentControllerEvent);
          mastra.emit({
            type: "tool_end",
            toolCallId: "read-1",
            result: "file contents",
            isError: false,
          } as AgentControllerEvent);
          mastra.emit({
            type: "message_end",
            message: {
              ...assistantMessage("Kimi answer"),
              threadId: String(kimiThreadId),
              resourceId: String(kimiThreadId),
            },
          } as AgentControllerEvent);
          mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
          mastra.finishSend();
          const completedEvent = yield* Fiber.join(completed);
          assert.equal(completedEvent._tag, "Some");
          yield* Fiber.interrupt(eventsFiber);

          const types = events.map((event) => event.type);
          for (const expected of [
            "turn.started",
            "session.state.changed",
            "item.started",
            "item.completed",
            "content.delta",
            "turn.completed",
          ]) {
            assert.include(types, expected);
          }
          const itemStarted = events.find((event) => event.type === "item.started");
          expect(itemStarted).toMatchObject({
            payload: { itemType: "file_change", title: "read_file" },
          });
          const toolItem = events.find(
            (event) => event.type === "item.completed" && String(event.itemId ?? "") === "read-1",
          );
          expect(toolItem).toMatchObject({ payload: { status: "completed" } });
          expect(mastra.sendMessage).toHaveBeenCalledWith({ content: "Read this file." });
          expect(mastra.session.model.switch).toHaveBeenCalledWith({
            modelId: "kimi-for-coding/k3-256k",
          });
          expect(bridge.startSession).not.toHaveBeenCalled();
          expect(bridge.sendTurn).not.toHaveBeenCalled();
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("Kimi Mastra normalization", () => {
    it.effect("normalizes a Kimi approval denial to the Mastra session", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* resolveKimi(controller);
          yield* controller.startSession(kimiThreadId, kimiStartInput("k3-256k"));

          const resolved = yield* controller.streamEvents.pipe(
            Stream.filter(
              (event) => event.type === "request.resolved" && event.payload.outcome === "denied",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          const turnEvents = yield* controller.streamEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "turn.completed" ||
                (event.type === "item.completed" && String(event.itemId ?? "") === "shell-1"),
            ),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Effect.yieldNow;
          yield* controller.sendTurn({ threadId: kimiThreadId, input: "Run a shell command." });
          yield* Effect.yieldNow;
          mastra.emit({
            type: "tool_approval_required",
            toolCallId: "shell-1",
            toolName: "Shell",
            args: { command: "rm -rf build" },
          } as AgentControllerEvent);
          yield* Effect.yieldNow;

          yield* controller.respondToRequest({
            threadId: kimiThreadId,
            requestId: ApprovalRequestId.make("shell-1"),
            decision: "decline",
          });
          const resolvedEvent = yield* Fiber.join(resolved);
          assert.equal(resolvedEvent._tag, "Some");

          expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
            toolCallId: "shell-1",
            decision: "decline",
          });
          expect(bridge.respondToRequest).not.toHaveBeenCalled();

          // The denied tool ends the call and the turn can still finish.
          mastra.emit({
            type: "tool_end",
            toolCallId: "shell-1",
            result: "denied",
            denied: true,
          } as AgentControllerEvent);
          mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
          mastra.finishSend();
          const events = yield* Fiber.join(turnEvents);
          const completed = [...events].find((event) => event.type === "turn.completed");
          const itemCompleted = [...events].find((event) => event.type === "item.completed");
          assert.equal(completed?.type, "turn.completed");
          if (completed?.type === "turn.completed") {
            assert.equal(completed.payload.state, "completed");
          }
          expect(itemCompleted).toMatchObject({ payload: { status: "declined" } });
          const [session] = yield* controller.listSessions();
          assert.isUndefined(session?.activeTurnId);
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("Kimi Mastra normalization", () => {
    it.effect("normalizes interrupting a Kimi turn mid-flight through Mastra abort", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();
      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* resolveKimi(controller);
          yield* controller.startSession(kimiThreadId, kimiStartInput("k3-256k"));

          const interrupted = yield* controller.streamEvents.pipe(
            Stream.filter(
              (event) => event.type === "turn.completed" && event.payload.state === "interrupted",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          const turn = yield* controller.sendTurn({
            threadId: kimiThreadId,
            input: "Work on this forever.",
          });
          yield* Effect.yieldNow;

          yield* controller.interruptTurn({ threadId: kimiThreadId });
          const event = yield* Fiber.join(interrupted);
          assert.equal(event._tag, "Some");
          if (event._tag === "Some") {
            assert.equal(event.value.turnId, turn.turnId);
          }
          expect(mastra.session.abort).toHaveBeenCalledOnce();
          expect(bridge.interruptTurn).not.toHaveBeenCalled();

          const [session] = yield* controller.listSessions();
          assert.isUndefined(session?.activeTurnId);
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });
});
