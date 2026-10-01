// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { createModelSelection } from "@akeru/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";
import {
  decodeClaudeSettings,
  ClaudeAdapter,
  FakeClaudeQuery,
  makeHarness,
  makeDeterministicRandomService,
  readFirstPromptText,
  readFirstPromptMessage,
  THREAD_ID,
} from "./test-support/claudeAdapterHarness.ts";

describe("ClaudeAdapterLive", () => {
  it.effect(
    "uses bypass permissions and general Akeru instructions for full-access claude sessions",
    () => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const createInput = harness.getLastCreateQueryInput();
        assert.equal(createInput?.options.permissionMode, "bypassPermissions");
        assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
        assert.deepInclude(createInput?.options.systemPrompt, {
          type: "preset",
          preset: "claude_code",
        });

        const appendedInstructions =
          typeof createInput?.options.systemPrompt === "object" &&
          "append" in createInput.options.systemPrompt
            ? (createInput.options.systemPrompt.append ?? "")
            : "";

        assert.include(appendedInstructions, "general assistant");
        assert.notInclude(appendedInstructions, "Before you use a tool");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});

describe("ClaudeAdapterLive", () => {
  it.effect("adds reply-first instructions to bot Claude sessions", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        botId: "bot-1" as never,
        botName: "Mina",
        personalityTone: 100,
      });

      const systemPrompt = harness.getLastCreateQueryInput()?.options.systemPrompt;

      const appendedInstructions =
        typeof systemPrompt === "object" && "append" in systemPrompt
          ? (systemPrompt.append ?? "")
          : "";

      assert.include(appendedInstructions, "Before you use a tool");
      assert.include(appendedInstructions, "automatic continuation");
      assert.include(appendedInstructions, "You are Mina");
      assert.include(appendedInstructions, "100/100, a 0% chill and 100% professional blend");
      assert.match(appendedInstructions, /Today is [A-Z][a-z]+, [A-Z][a-z]+ \d{1,2}, \d{4}/);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("treats ultrathink as a prompt keyword instead of a session effort", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "ultrathink" }],
        ),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Investigate the edge cases",
        attachments: [],
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "ultrathink" }],
        ),
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
      const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
      assert.equal(promptText, "Ultrathink:\nInvestigate the edge cases");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("keeps compact commands intact when ultrathink is selected", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const modelSelection = createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "ultrathink" }],
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/compact",
        attachments: [],
        modelSelection,
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );

      assert.equal(promptText, "/compact");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("embeds image attachments in Claude user messages", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-attachments-"));

    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments",
      baseDir,
    });

    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          NodeFS.rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };

      const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment));
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "What's in this image?",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
        {
          type: "text",
          text: "What's in this image?",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("stopSession does not throw into the SDK prompt consumer", () => {
    // The SDK consumes user messages via `for await (... of prompt)`.
    // Stopping a session must end that loop cleanly — not throw an error.
    //
    // FakeClaudeQuery.close() masks this by resolving pending iterators
    // before the shutdown propagates. Override it to match real SDK behavior
    // where close() does not resolve the prompt consumer.
    const query = new FakeClaudeQuery();
    (query as { close: () => void }).close = () => {
      query.closeCalls += 1;
    };

    let promptConsumerError: unknown = undefined;

    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});

        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: (input) => {
            // Simulate the SDK consuming the prompt iterable
            (async () => {
              try {
                for await (const _message of input.prompt) {
                  /* SDK processes user messages */
                }
              } catch (error) {
                promptConsumerError = error;
              }
            })();

            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.runForEach(
        adapter.streamEvents,
        () => Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(THREAD_ID);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      runtimeEventsFiber.interruptUnsafe();

      assert.equal(
        promptConsumerError,
        undefined,
        `Prompt consumer should not receive a thrown error on session stop, ` +
          `but got: "${promptConsumerError instanceof Error ? promptConsumerError.message : String(promptConsumerError)}"`,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("consumes Claude command lifecycle notifications silently", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const sessionId = "6e81554e-5cff-4b37-8a39-f3a9051ac234";

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const readyMessage = "command lifecycle test ready";

      const readyFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning" && event.payload.message === readyMessage,
      ).pipe(Stream.runDrain, Effect.forkChild);

      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "command-lifecycle-ready",
        text: readyMessage,
        priority: "high",
        session_id: sessionId,
        uuid: "command-lifecycle-ready",
      } as unknown as SDKMessage);
      yield* Fiber.join(readyFiber);

      const processedMessage = "command lifecycle messages processed";

      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning" && event.payload.message === processedMessage,
      ).pipe(Stream.runCollect, Effect.forkChild);

      for (const [state, uuid] of [
        ["started", "command-started"],
        ["completed", "command-completed"],
      ]) {
        harness.query.emit({
          type: "command_lifecycle",
          command_uuid: "4cd8e8a3-df7a-425d-b6c9-4053abc0b8fd",
          state,
          session_id: sessionId,
          uuid,
        } as unknown as SDKMessage);
      }

      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "command-lifecycle-processed",
        text: processedMessage,
        priority: "high",
        session_id: sessionId,
        uuid: "command-lifecycle-processed",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["runtime.warning"],
      );
      const warning = runtimeEvents[0];
      assert.equal(warning?.type, "runtime.warning");

      if (warning?.type === "runtime.warning") {
        assert.equal(warning.payload.message, processedMessage);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
