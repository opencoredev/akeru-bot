// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off

import {
  createdAt,
  projectId,
  modelSelection,
  PROMPT,
  fakeAdapter,
  fakeSubscriptions,
  testLayer,
  tempBaseDir,
  createBot,
  createProject,
  createBotThread,
  sendUserMessage,
  generatedMessages,
} from "./testUtils/imageGenerationRuntime.ts";
import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { AuthSessionId, BotId, CommandId, GroupId, ThreadId } from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { BotUsageLedger } from "../usage/BotUsageLedger.ts";
import { type ImageAdapterRequest } from "./adapters.ts";
import { ImageGenerationRuntime, makeImageGenerationRuntime } from "./ImageGenerationRuntime.ts";
import { base64, pngBytes } from "./testImages.ts";
describe("ImageGenerationRuntime", () => {
  it.effect("reports a partial result when some returned images are unusable", () => {
    const chatgpt = fakeAdapter("chatgpt");
    let call = 0;
    const adapters = {
      chatgpt: {
        ...chatgpt,
        run: (request: ImageAdapterRequest, signal: AbortSignal) => {
          call += 1;
          return call === 1
            ? chatgpt.run(request, signal)
            : Promise.resolve({
                images: [new Uint8Array([1, 2, 3])],
                model: "chatgpt-image-model",
              });
        },
      },
      grok: fakeAdapter("grok"),
    };
    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const botId = BotId.make("bot-partial");
      const threadId = ThreadId.make("thread-partial");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);
      yield* sendUserMessage(threadId, "partial");

      const result = yield* runtime.generate(threadId, {
        operation: "generate",
        prompt: PROMPT,
        count: 2,
      });

      assert.equal(result.status === "failed" && result.kind, "provider-failed");
      const [message] = yield* generatedMessages(threadId);
      assert.equal(message?.attachments?.length, 1);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("removes saved images when posting them fails", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt"), grok: fakeAdapter("grok") };
    return Effect.gen(function* () {
      const config = yield* ServerConfig;
      const engine = yield* OrchestrationEngineService;
      const botId = BotId.make("bot-post-fails");
      const threadId = ThreadId.make("thread-post-fails");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);
      yield* sendUserMessage(threadId, "post-fails");
      const runtime = yield* makeImageGenerationRuntime({
        adapters,
        subscriptionAuth: fakeSubscriptions(),
      }).pipe(
        Effect.provideService(OrchestrationEngineService, {
          ...engine,
          dispatch: (command) =>
            command.type === "thread.message.assistant.delta"
              ? Effect.die("post failed")
              : engine.dispatch(command),
        }),
      );

      const result = yield* runtime.generate(threadId, { operation: "generate", prompt: PROMPT });

      assert.notEqual(result.status, "completed");
      const saved = NodeFS.existsSync(config.attachmentsDir)
        ? NodeFS.readdirSync(config.attachmentsDir, { recursive: true }).filter((entry) =>
            String(entry).includes("."),
          )
        : [];
      assert.deepEqual(saved, []);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("keeps saved images once the message references them", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt"), grok: fakeAdapter("grok") };
    return Effect.gen(function* () {
      const config = yield* ServerConfig;
      const engine = yield* OrchestrationEngineService;
      const botId = BotId.make("bot-complete-fails");
      const threadId = ThreadId.make("thread-complete-fails");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);
      yield* sendUserMessage(threadId, "complete-fails");
      const runtime = yield* makeImageGenerationRuntime({
        adapters,
        subscriptionAuth: fakeSubscriptions(),
      }).pipe(
        Effect.provideService(OrchestrationEngineService, {
          ...engine,
          dispatch: (command) =>
            command.type === "thread.message.assistant.complete"
              ? Effect.die("complete failed")
              : engine.dispatch(command),
        }),
      );

      const result = yield* runtime.generate(threadId, { operation: "generate", prompt: PROMPT });

      assert.notEqual(result.status, "completed");
      const saved = NodeFS.existsSync(config.attachmentsDir)
        ? NodeFS.readdirSync(config.attachmentsDir, { recursive: true }).filter((entry) =>
            String(entry).includes("."),
          )
        : [];
      assert.equal(saved.length, 1);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("rejects input images that are not from the chat", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt"), grok: fakeAdapter("grok") };
    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const botId = BotId.make("bot-foreign");
      const threadId = ThreadId.make("thread-foreign");
      yield* createProject;
      yield* createBot(botId, "codex", null);
      yield* createBotThread(threadId, botId);

      const result = yield* runtime.generate(threadId, {
        operation: "edit",
        prompt: PROMPT,
        inputImages: ["other-thread-image"],
      });
      const strict = yield* runtime.generate(threadId, {
        operation: "generate",
        prompt: PROMPT,
        size: "4096x4096",
      });

      assert.equal(result.status === "failed" && result.kind, "invalid-request");
      assert.equal(strict.status === "failed" && strict.kind, "invalid-request");
      assert.equal(adapters.chatgpt.calls.length, 0);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("cancels an in-flight request for the chat and posts nothing", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt", "hang"), grok: fakeAdapter("grok") };
    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-cancel");
      const threadId = ThreadId.make("thread-cancel");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);

      const fiber = yield* runtime
        .generate(threadId, { operation: "generate", prompt: PROMPT })
        .pipe(Effect.forkChild);
      yield* Deferred.await(adapters.chatgpt.started);
      yield* runtime.cancelThread(threadId);
      const result = yield* Fiber.join(fiber);

      assert.equal(result.status === "failed" && result.kind, "cancelled");
      assert.equal(adapters.chatgpt.signals[0]!.aborted, true);
      assert.equal(adapters.grok.calls.length, 0);
      assert.equal((yield* generatedMessages(threadId)).length, 0);
      assert.equal((yield* ledger.summarize(botId)).entries.length, 0);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("aborts in-flight requests when the runtime shuts down", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt", "hang"), grok: fakeAdapter("grok") };
    return Effect.gen(function* () {
      const botId = BotId.make("bot-shutdown");
      const threadId = ThreadId.make("thread-shutdown");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);

      const scope = yield* Scope.make();
      const runtime = yield* makeImageGenerationRuntime({
        adapters,
        subscriptionAuth: fakeSubscriptions(),
      }).pipe(Scope.provide(scope));
      const fiber = yield* runtime
        .generate(threadId, { operation: "generate", prompt: PROMPT })
        .pipe(Effect.forkChild);
      yield* Deferred.await(adapters.chatgpt.started);
      yield* Scope.close(scope, Exit.void);
      const result = yield* Fiber.join(fiber);

      assert.equal(result.status === "failed" && result.kind, "cancelled");
      assert.equal(adapters.chatgpt.signals[0]!.aborted, true);
      assert.equal((yield* generatedMessages(threadId)).length, 0);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("charges the responding bot in a group chat and posts to the group", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt"), grok: fakeAdapter("grok") };
    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const engine = yield* OrchestrationEngineService;
      const ledger = yield* BotUsageLedger;
      const boss = BotId.make("bot-boss");
      const specialist = BotId.make("bot-specialist");
      const groupId = GroupId.make("group-images");
      const threadId = ThreadId.make("thread-group");
      const personId = AuthSessionId.make("person-designer");
      yield* createProject;
      yield* createBot(boss, "codex", null);
      yield* createBot(specialist, "claudeAgent", "grok");
      yield* engine.dispatch({
        type: "group.create",
        commandId: CommandId.make("cmd-group"),
        groupId,
        name: "Design",
        bossBotId: boss,
        specialistBotIds: [specialist],
        creator: { kind: "person", personId, displayName: "Designer" },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-group-thread"),
        threadId,
        projectId,
        groupId,
        title: "Group poster",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* sendUserMessage(threadId, "group", [], { respondingBotId: specialist, personId });

      const result = yield* runtime.generate(threadId, { operation: "generate", prompt: PROMPT });

      assert.equal(result.status === "completed" && result.provider, "grok");
      assert.equal((yield* generatedMessages(threadId)).length, 1);
      assert.equal((yield* ledger.summarize(specialist)).entries.length, 1);
      assert.equal((yield* ledger.summarize(boss)).entries.length, 0);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("keeps generated images after a restart", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt"), grok: fakeAdapter("grok") };
    const baseDir = tempBaseDir();
    const threadId = ThreadId.make("thread-restart");
    return Effect.gen(function* () {
      const attachmentId = yield* Effect.gen(function* () {
        const runtime = yield* ImageGenerationRuntime;
        const botId = BotId.make("bot-restart");
        yield* createProject;
        yield* createBot(botId, "claudeAgent", null);
        yield* createBotThread(threadId, botId);
        const result = yield* runtime.generate(threadId, {
          operation: "generate",
          prompt: PROMPT,
        });
        return result.status === "completed" ? result.artifacts[0]!.attachmentId : "";
      }).pipe(Effect.provide(testLayer({ baseDir, adapters })));

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig;
        const [message] = yield* generatedMessages(threadId);
        const attachment = message?.attachments?.[0];
        assert.equal(attachment?.id, attachmentId);
        const path = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: attachment!,
        })!;
        assert.equal(NodeFS.existsSync(path), true);
      }).pipe(Effect.provide(testLayer({ baseDir, adapters })));
    });
  });

  it.effect("keeps prompts and image bytes out of events and usage rows", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt"), grok: fakeAdapter("grok") };
    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const sql = yield* SqlClient.SqlClient;
      const botId = BotId.make("bot-private");
      const threadId = ThreadId.make("thread-private");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);

      const result = yield* runtime.generate(threadId, { operation: "generate", prompt: PROMPT });
      assert.equal(result.status, "completed");

      const events = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS "payload" FROM orchestration_events
      `;
      const usage = yield* sql<Record<string, unknown>>`SELECT * FROM akeru_bot_usage_entries`;
      assert.equal(events.length > 0 && usage.length === 1, true);
      const stored = [
        ...events.map((event) => event.payload),
        ...usage.flatMap((row) => Object.values(row).map(String)),
      ].join("\n");
      assert.equal(stored.includes(PROMPT), false);
      assert.equal(stored.includes(base64(pngBytes(1024, 1024))), false);
      assert.equal(Object.values(result).map(String).join("\n").includes(PROMPT), false);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });
});
