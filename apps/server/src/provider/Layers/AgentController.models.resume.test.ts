// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, describe, expect, vi } from "vite-plus/test";
import { ServerConfig } from "../../config.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { EntityMemoryRepository } from "../../memory/Services/EntityMemoryRepository.ts";
import { AgentController } from "../Services/AgentController.ts";
import { makeAkeruMastraHarness } from "../AkeruMastraHarness.ts";
import { LegacyProviderBridge } from "../Services/LegacyProviderBridge.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import { makeAgentControllerLive, type AgentControllerLiveOptions } from "./AgentController.ts";
import { BotUsageLedger } from "../../usage/BotUsageLedger.ts";
import {
  claudeThreadId,
  kimiThreadId,
  claudeInstanceId,
  openCodeInstanceId,
  kimiInstanceId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  makeLayer,
  provideController,
  kimiModel,
  kimiStartInput,
  resolveKimi,
  mastraWireCases,
} from "./test-support/agentControllerLayers.ts";
import { makeUsageLedger } from "./test-support/agentControllerMemory.ts";
import { makeMastraHarness } from "./test-support/agentControllerHarness.ts";

describe("AgentControllerLive", () => {
  describe("Kimi Mastra normalization", () => {
    it.effect("resumes a Kimi thread through a fresh controller after a server restart", () => {
      // Restart means the controller scope closes and a new layer is built
      // against the same persisted state directory. A fresh Mastra harness
      // (fresh createSession spies) proves nothing in-memory leaks across
      // the boundary, and the bridge never sees a session call.
      const bridge = makeBridge();
      const mastraBefore = makeMastraHarness();
      const mastraAfter = makeMastraHarness();
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-kimi-restart-"));

      const layer = (factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]>) =>
        makeLayer(bridge.service, factory, undefined, baseDir);

      return Effect.gen(function* () {
        const firstScope = yield* Scope.make("sequential");
        const firstContext = yield* Layer.buildWithScope(layer(mastraBefore.factory), firstScope);
        const first = Context.get(firstContext, AgentController);
        yield* first.resolveEngine({
          threadId: kimiThreadId,
          engine: { provider: String(kimiInstanceId), model: "k3-256k" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* first.startSession(kimiThreadId, kimiStartInput("k3-256k"));
        yield* first.sendTurn({ threadId: kimiThreadId, input: "Before restart." });
        yield* Effect.yieldNow;
        mastraBefore.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastraBefore.finishSend();
        yield* Effect.yieldNow;
        yield* Scope.close(firstScope, Exit.void);
        expect(mastraBefore.session.abort).toHaveBeenCalled();

        const secondScope = yield* Scope.make("sequential");
        const secondContext = yield* Layer.buildWithScope(layer(mastraAfter.factory), secondScope);
        const second = Context.get(secondContext, AgentController);
        // The saved model is re-resolved from the thread's engine selection —
        // not carried over in memory — and the new scope builds a fresh
        // Mastra session for the same thread.
        yield* second.resolveEngine({
          threadId: kimiThreadId,
          engine: { provider: String(kimiInstanceId), model: "k3-256k" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        yield* second.startSession(kimiThreadId, kimiStartInput("k3-256k"));

        const completed = yield* second.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* second.sendTurn({ threadId: kimiThreadId, input: "After restart." });
        yield* Effect.yieldNow;
        mastraAfter.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
        mastraAfter.finishSend();
        assert.equal((yield* Fiber.join(completed))._tag, "Some");

        expect(mastraAfter.createSession).toHaveBeenCalledOnce();
        expect(mastraAfter.session.model.switch).toHaveBeenCalledWith({
          modelId: "kimi-for-coding/k3-256k",
        });
        expect(mastraAfter.sendMessage).toHaveBeenCalledWith({ content: "After restart." });
        yield* Scope.close(secondScope, Exit.void);
        expect(bridge.startSession).not.toHaveBeenCalled();
        expect(bridge.sendTurn).not.toHaveBeenCalled();
        expect(bridge.stopSession).not.toHaveBeenCalled();
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
        ),
        Effect.orDie,
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("Kimi Mastra normalization", () => {
    it.effect("normalizes a Kimi model switch in-session between turns", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* resolveKimi(controller, "kimi-for-coding");
          yield* controller.startSession(kimiThreadId, kimiStartInput("kimi-for-coding"));
          yield* controller.sendTurn({ threadId: kimiThreadId, input: "First turn." });
          yield* Effect.yieldNow;
          mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
          mastra.finishSend();
          yield* Effect.yieldNow;
          expect(mastra.session.model.switch).toHaveBeenCalledWith({
            modelId: "kimi-for-coding/kimi-for-coding",
          });

          // The user picks a different advertised model; the existing Mastra
          // session absorbs the switch instead of being rebuilt.
          yield* resolveKimi(controller, "kimi-for-coding-highspeed");
          expect(mastra.session.model.switch).toHaveBeenCalledWith({
            modelId: "kimi-for-coding/kimi-for-coding-highspeed",
          });
          expect(mastra.createSession).toHaveBeenCalledOnce();

          const completed = yield* controller.streamEvents.pipe(
            Stream.filter((event) => event.type === "turn.completed"),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );

          yield* controller.sendTurn({
            threadId: kimiThreadId,
            input: "Second turn.",
            modelSelection: kimiModel("kimi-for-coding-highspeed"),
          });
          yield* Effect.yieldNow;
          mastra.emit({ type: "agent_end", reason: "complete" } as AgentControllerEvent);
          mastra.finishSend();
          assert.equal((yield* Fiber.join(completed))._tag, "Some");

          const [session] = yield* controller.listSessions();
          assert.equal(session?.model, "kimi-for-coding-highspeed");
          expect(mastra.sendMessage).toHaveBeenNthCalledWith(2, { content: "Second turn." });
          expect(bridge.sendTurn).not.toHaveBeenCalled();
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });
});

describe("AgentControllerLive", () => {
  it.effect(
    "runs a real Mastra turn for Kimi through AkeruKimiProvider and a fake transport",
    () => {
      // This is the causal-flow proof the mocked-harness tests cannot give:
      // `sendTurn` drives the real Mastra Session, the resolved model is the
      // real `akeruKimiProvider` Anthropic transport, the scripted SSE reply
      // produces a `tool_approval_required`, the controller response resumes
      // the run, and `turn.completed` lands through the real event pipeline.
      const bridge = makeBridge();

      const kimiRequests: Array<{
        readonly url: string;
        readonly body: string;
        readonly headers: Record<string, string>;
      }> = [];

      // Scripted Kimi replies: the first request emits a Shell tool_use, and
      // the post-approval resume ends the turn with a text reply. The SSE
      // parser only emits a tool_call when the `content_block_start` carries
      // the full `input` object — streaming `input_json_delta` args alone
      // leaves the call without a parsed tool_use payload.
      const toolCallSse =
        [
          "event: message_start",
          'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"kimi-for-coding","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
          "event: content_block_start",
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_shell","name":"Shell","input":{"command":"pwd"}}}',
          "event: content_block_stop",
          'data: {"type":"content_block_stop","index":0}',
          "event: message_delta",
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}',
          "event: message_stop",
          'data: {"type":"message_stop"}',
        ].join("\n\n") + "\n\n";

      const endTurnSse =
        [
          "event: message_start",
          'data: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","model":"kimi-for-coding","content":[],"stop_reason":null,"usage":{"input_tokens":20,"output_tokens":0}}}',
          "event: content_block_start",
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"pwd printed the working directory."}}',
          "event: content_block_stop",
          'data: {"type":"content_block_stop","index":0}',
          "event: message_delta",
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
          "event: message_stop",
          'data: {"type":"message_stop"}',
        ].join("\n\n") + "\n\n";

      const fakeKimi = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        const body = typeof init?.body === "string" ? init.body : "";

        const headers = Object.fromEntries(
          new Headers(input instanceof Request ? input.headers : (init?.headers ?? {})),
        );

        kimiRequests.push({ url, body, headers });

        return new Response(kimiRequests.length === 1 ? toolCallSse : endTurnSse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-kimi-e2e-"));
      NodeFS.mkdirSync(NodePath.join(baseDir, "userdata", "secrets"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(baseDir, "userdata", "secrets", "subscription-auth.json"),
        JSON.stringify({
          "kimi-for-coding": {
            type: "oauth",
            access: "kimi-e2e-token",
            refresh: "kimi-e2e-refresh",
            expires: 4_102_444_800_000,
            deviceId: "0123456789abcdef0123456789abcdef",
          },
        }),
      );

      const originalFetch = globalThis.fetch;

      const fetchPatched = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        return url.startsWith("https://api.kimi.com/coding/v1/messages")
          ? fakeKimi(input as string | URL | Request, init as RequestInit | undefined)
          : originalFetch(input, init);
      });

      const layer = makeAgentControllerLive({
        makeMastraHarness: makeAkeruMastraHarness,
        makeBotBrowser: () => ({
          tools: {},
          attachment: async () => undefined,
          reconnect: async () => undefined,
          close: async () => undefined,
        }),
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(LegacyProviderBridge, bridge.service),
            Layer.succeed(BotUsageLedger, makeUsageLedger().service),
            Layer.mock(EntityMemoryRepository)({}),
            serverSettingsLayerTest({}),
            ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
            NodeServices.layer,
          ),
        ),
      );

      return Effect.gen(function* () {
        const unrelated = yield* Effect.promise(() =>
          fetch("data:text/plain,unrelated").then((response) => response.text()),
        );

        assert.equal(unrelated, "unrelated");
        assert.equal(kimiRequests.length, 0);
        const scope = yield* Scope.make("sequential");
        const context = yield* Layer.buildWithScope(layer, scope);
        const controller = Context.get(context, AgentController);

        yield* controller.resolveEngine({
          threadId: kimiThreadId,
          engine: { provider: String(kimiInstanceId), model: "kimi-for-coding" },
          fallback: codexSelection,
          mode: "default",
          botConversation: true,
        });
        // No cwd and sandbox: "none" would keep the model's tool list empty;
        // the harness is verified with the real Akeru tool surface, so use a
        // local workspace rooted at the repo checkout.
        yield* controller.startSession(kimiThreadId, {
          threadId: kimiThreadId,
          provider: ProviderDriverKind.make("kimi"),
          providerInstanceId: kimiInstanceId,
          cwd: process.cwd(),
          modelSelection: { instanceId: kimiInstanceId, model: "kimi-for-coding" },
          runtimeMode: "approval-required",
          botSandbox: "local",
        });

        const events: ProviderRuntimeEvent[] = [];

        const collector = yield* controller.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );

        const opened = yield* controller.streamEvents.pipe(
          Stream.filter(
            (event) => event.type === "request.opened" && event.threadId === kimiThreadId,
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;

        yield* controller.sendTurn({ threadId: kimiThreadId, input: "Run pwd." });
        // The model request is the deterministic fake transport — the turn is
        // now parked on the interactive tool-approval gate the harness raised.
        assert.equal((yield* Fiber.join(opened))._tag, "Some");
        assert.equal(kimiRequests.length, 1);
        expect(kimiRequests[0]!.url).toContain("api.kimi.com/coding/v1/messages");
        expect(kimiRequests[0]!.headers["authorization"]).toBe("Bearer kimi-e2e-token");
        expect(kimiRequests[0]!.headers["x-msh-device-id"]).toBeDefined();

        const completed = yield* controller.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* controller.respondToRequest({
          threadId: kimiThreadId,
          requestId: ApprovalRequestId.make("toolu_shell"),
          decision: "accept",
        });

        // Approving resumes the provider turn; the scripted second model reply
        // completes it. The completion receipt is the proof the whole chain ran.
        yield* Fiber.join(completed).pipe(Effect.timeout(10_000), Effect.orDie);

        // The controller emitted the approval request, the resolved approval,
        // the tool item, and the completed turn — in that causal order.
        const types = events.map((event) => event.type);

        const causalOrder = [
          types.indexOf("turn.started"),
          types.indexOf("request.opened"),
          types.indexOf("request.resolved"),
          types.indexOf("item.completed"),
          types.indexOf("turn.completed"),
        ];

        assert.notInclude(causalOrder, -1);
        assert.deepEqual(
          [...causalOrder].sort((a, b) => a - b),
          causalOrder,
        );
        const resolved = events.find((event) => event.type === "request.resolved");
        expect(resolved).toMatchObject({ payload: { outcome: "approved" } });
        const itemCompleted = events.find((event) => event.type === "item.completed");
        expect(itemCompleted).toMatchObject({ payload: { status: "completed" } });
        const finished = events.find((event) => event.type === "turn.completed");
        expect(finished).toMatchObject({ payload: { state: "completed" } });
        // The resume ran the approved tool call through the runtime and asked
        // the model for its follow-up, so the transport saw a second request
        // carrying the tool result back to Kimi.
        assert.equal(kimiRequests.length, 2);
        expect(kimiRequests[1]!.body).toContain('"tool_result"');
        expect(bridge.sendTurn).not.toHaveBeenCalled();
        expect(bridge.startSession).not.toHaveBeenCalled();

        yield* Fiber.interrupt(collector);
        yield* Scope.close(scope, Exit.void);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            fetchPatched.mockRestore();
            NodeFS.rmSync(baseDir, { recursive: true, force: true });
          }),
        ),
        Effect.orDie,
      );
    },
  );
});

describe("AgentControllerLive", () => {
  it.effect("does not fall back to the legacy Kimi loop when its Mastra session is absent", () => {
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

        const error = yield* controller
          .sendTurn({ threadId: kimiThreadId, input: "No legacy fallback." })
          .pipe(Effect.flip);

        assert.equal(error._tag, "AgentControllerRuntimeError");
        expect(bridge.sendTurn).not.toHaveBeenCalled();
      }),
      bridge.service,
      mastra.factory,
    );
  });
});

describe("AgentControllerLive", () => {
  describe("per-driver wire-format model routing", () => {
    for (const testCase of mastraWireCases) {
      it.effect(`sends the saved ${testCase.provider} model to the Mastra wire`, () => {
        const bridge = makeBridge();
        const mastra = makeMastraHarness();

        const modelSelection = {
          instanceId: testCase.instanceId,
          model: testCase.model,
          ...(testCase.options ? { options: [...testCase.options] } : {}),
        };

        return provideController(
          Effect.gen(function* () {
            const controller = yield* AgentController;
            yield* controller.resolveEngine({
              threadId: testCase.threadId,
              engine: {
                provider: String(testCase.instanceId),
                model: testCase.model,
                ...(testCase.options ? { options: [...testCase.options] } : {}),
              },
              fallback: codexSelection,
              mode: "default",
              botConversation: true,
            });

            const session = yield* controller.startSession(testCase.threadId, {
              threadId: testCase.threadId,
              provider: testCase.provider,
              providerInstanceId: testCase.instanceId,
              cwd: process.cwd(),
              modelSelection,
              runtimeMode: "approval-required",
            });

            assert.equal(session.provider, testCase.provider);
            assert.equal(session.model, testCase.model);

            yield* controller.sendTurn({ threadId: testCase.threadId, input: "Route me." });
            yield* Effect.promise(() => mastra.waitForSendMessageCount(1));
            mastra.finishSend();
            yield* Effect.yieldNow;

            expect(mastra.session.model.switch).toHaveBeenCalledWith({
              modelId: testCase.wireModelId,
            });

            if (testCase.modelOptions !== undefined) {
              expect(mastra.session.state.set).toHaveBeenLastCalledWith(
                expect.objectContaining({ modelOptions: testCase.modelOptions }),
              );
            }

            expect(mastra.sendMessage).toHaveBeenCalledWith({ content: "Route me." });
            expect(bridge.startSession).not.toHaveBeenCalled();
            expect(bridge.sendTurn).not.toHaveBeenCalled();
          }),
          bridge.service,
          mastra.factory,
        );
      });
    }
  });
});

describe("AgentControllerLive", () => {
  describe("per-driver wire-format model routing", () => {
    it.effect("sends the saved OpenCode model to the legacy bridge", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();

      const modelSelection = {
        instanceId: openCodeInstanceId,
        model: "anthropic/claude-sonnet-4-5",
        options: [
          { id: "agent", value: "build" },
          { id: "variant", value: "high" },
        ],
      };

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* controller.resolveEngine({
            threadId: claudeThreadId,
            engine: {
              provider: String(openCodeInstanceId),
              model: "anthropic/claude-sonnet-4-5",
              options: [
                { id: "agent", value: "build" },
                { id: "variant", value: "high" },
              ],
            },
            fallback: codexSelection,
            mode: "default",
            botConversation: true,
          });

          const session = yield* controller.startSession(claudeThreadId, {
            threadId: claudeThreadId,
            provider: ProviderDriverKind.make("opencode"),
            providerInstanceId: openCodeInstanceId,
            cwd: process.cwd(),
            modelSelection,
            runtimeMode: "approval-required",
          });

          assert.equal(session.provider, "opencode");

          yield* controller.sendTurn({
            threadId: claudeThreadId,
            input: "Route me.",
            modelSelection,
          });

          expect(bridge.startSession).toHaveBeenCalledOnce();
          expect(bridge.startSession.mock.calls[0]?.[1]).toMatchObject({ modelSelection });
          const sentInput = bridge.sendTurn.mock.calls[0]?.[0];
          expect(sentInput?.threadId).toBe(claudeThreadId);
          expect(sentInput?.modelSelection).toEqual(modelSelection);
          expect(mastra.sendMessage).not.toHaveBeenCalled();
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });
});

describe("AgentControllerLive", () => {
  describe("per-driver wire-format model routing", () => {
    it.effect.each([
      {
        provider: "codex",
        instanceId: "codex-isolated",
        issue: "This Codex instance needs OPENAI_API_KEY",
      },
      {
        provider: "claudeAgent",
        instanceId: "claudeAgent-isolated",
        issue: "This Claude instance needs an API key or auth token",
      },
      {
        provider: "grok",
        instanceId: "grok-isolated",
        issue: "This Grok instance needs XAI_API_KEY",
      },
      {
        provider: "kimi",
        instanceId: "kimi-isolated",
        issue: "Custom Kimi credentials are not supported",
      },
      {
        provider: "opencodeGo",
        instanceId: "opencodeGo-isolated",
        issue: "This OpenCode Go instance needs OPENCODE_API_KEY",
      },
    ] as const)(
      "fails closed for $provider when no credential transport is configured",
      ({ provider, instanceId: _instanceSlug, issue: expectedIssue }) => {
        const bridge = makeBridge();
        const mastra = makeMastraHarness();
        const threadId = ThreadId.make(`thread-${provider.toLowerCase()}-isolated`);

        const service: ProviderServiceShape = {
          ...bridge.service,
          getInstanceInfo: (candidate) =>
            Effect.succeed({
              instanceId: candidate,
              driverKind: ProviderDriverKind.make(provider),
              displayName: undefined,
              enabled: true,
              continuationIdentity: {
                driverKind: ProviderDriverKind.make(provider),
                continuationKey: `${provider}:instance:${candidate}`,
              },
              mastraConnection: {
                environment: {},
                instanceEnvironment: {},
                useSavedCredential: false,
              },
            }),
        };

        return provideController(
          Effect.gen(function* () {
            const controller = yield* AgentController;

            const error = yield* controller
              .resolveEngine({
                threadId,
                engine: { provider, model: "removed-model" },
                fallback: codexSelection,
                mode: "default",
                botConversation: true,
              })
              .pipe(Effect.flip);

            assert.equal(error._tag, "AgentControllerUnsupportedEngineError");

            if (error._tag === "AgentControllerUnsupportedEngineError") {
              assert.include(error.detail, `Provider instance '${provider}' is not available.`);

              const causeMessage =
                error.cause instanceof Error ? error.cause.message : String(error.cause ?? "");

              assert.include(causeMessage, expectedIssue);
            }

            expect(bridge.startSession).not.toHaveBeenCalled();
            expect(bridge.sendTurn).not.toHaveBeenCalled();
            expect(mastra.session.model.switch).not.toHaveBeenCalled();
          }),
          service,
          mastra.factory,
        );
      },
    );
  });
});

describe("AgentControllerLive", () => {
  describe("per-driver wire-format model routing", () => {
    it.effect("fails closed for a disabled saved provider instead of rerouting", () => {
      const bridge = makeBridge();
      const mastra = makeMastraHarness();

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          bridge.setInstanceEnabled(false);

          const error = yield* controller
            .resolveEngine({
              threadId: claudeThreadId,
              engine: { provider: String(claudeInstanceId), model: "claude-opus-4-6" },
              fallback: codexSelection,
              mode: "default",
              botConversation: true,
            })
            .pipe(Effect.flip);

          assert.equal(error._tag, "ProviderValidationError");

          if (error._tag === "ProviderValidationError") {
            assert.include(error.issue, "disabled in Akeru Bot settings");
          }

          expect(bridge.startSession).not.toHaveBeenCalled();
          expect(bridge.sendTurn).not.toHaveBeenCalled();
          expect(mastra.session.model.switch).not.toHaveBeenCalled();
        }),
        bridge.service,
        mastra.factory,
      );
    });
  });
});
