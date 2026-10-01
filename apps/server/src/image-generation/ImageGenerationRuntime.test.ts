
import {
  PROMPT,
  fakeAdapter,
  fakeSubscriptions,
  bothEnabled,
  testLayer,
  tempBaseDir,
  createBot,
  createProject,
  createBotThread,
  sendUserMessage,
  saveUserImage,
  generatedMessages,
} from "./testUtils/imageGenerationRuntime.ts";
import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { BotId, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { BotUsageLedger } from "../usage/BotUsageLedger.ts";
import { ImageAdapterFailure, type ImageAdapterRequest } from "./adapters.ts";
import { ImageGenerationRuntime } from "./ImageGenerationRuntime.ts";
import { pngBytes } from "./testImages.ts";

describe("ImageGenerationRuntime", () => {
  it.effect("saves the image, posts it to the chat, and records usage for the bot", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt"), grok: fakeAdapter("grok") };

    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const config = yield* ServerConfig;
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-claude");
      const threadId = ThreadId.make("thread-persist");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);
      yield* sendUserMessage(threadId, "persist");

      const result = yield* runtime.generate(threadId, { operation: "generate", prompt: PROMPT });

      assert.equal(result.status, "completed");

      if (result.status !== "completed") return;
      assert.deepEqual(result.artifacts, [
        {
          attachmentId: result.artifacts[0]!.attachmentId,
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          sizeBytes: pngBytes(1024, 1024).byteLength,
          provider: "chatgpt",
          model: "chatgpt-image-model",
        },
      ]);
      const [message] = yield* generatedMessages(threadId);
      assert.equal(message?.role, "assistant");
      assert.equal(message?.text, "");
      const attachment = message?.attachments?.[0];
      assert.equal(attachment?.id, result.artifacts[0]!.attachmentId);

      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: attachment!,
      })!;

      assert.deepEqual(new Uint8Array(NodeFS.readFileSync(path)), pngBytes(1024, 1024));

      const usage = yield* ledger.summarize(botId);
      assert.deepEqual(
        usage.entries.map((entry) => ({
          category: entry.category,
          provider: String(entry.provider),
          outputTokens: entry.outputTokens,
        })),
        [{ category: "tool", provider: "chatgpt", outputTokens: 1_000 }],
      );
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("posts and bills a successful image when the next ChatGPT request fails", () => {
    const chatgpt = fakeAdapter("chatgpt");
    const run = chatgpt.run;
    let calls = 0;

    const adapters = {
      chatgpt: {
        ...chatgpt,
        run: (request: ImageAdapterRequest, signal: AbortSignal) => {
          calls += 1;

          return calls === 2
            ? Promise.reject(new ImageAdapterFailure("provider-failed", "Second failed."))
            : run(request, signal);
        },
      },
      grok: fakeAdapter("grok"),
    };

    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-partial-failure");
      const threadId = ThreadId.make("thread-partial-failure");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);

      const result = yield* runtime.generate(threadId, {
        operation: "generate",
        prompt: PROMPT,
        count: 2,
        provider: "chatgpt",
      });

      assert.equal(result.status, "failed");
      const messages = yield* generatedMessages(threadId);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.attachments?.length, 1);
      const usage = yield* ledger.summarize(botId);
      assert.deepEqual(
        usage.entries.map((entry) => String(entry.provider)),
        ["chatgpt"],
      );
      assert.equal(calls, 2);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("attributes partial ChatGPT images and remaining Grok images separately", () => {
    const chatgpt = fakeAdapter("chatgpt");
    const run = chatgpt.run;
    let calls = 0;

    const adapters = {
      chatgpt: {
        ...chatgpt,
        run: (request: ImageAdapterRequest, signal: AbortSignal) => {
          calls += 1;

          return calls === 2
            ? Promise.reject(new ImageAdapterFailure("provider-failed", "Second failed."))
            : run(request, signal);
        },
      },
      grok: fakeAdapter("grok"),
    };

    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const ledger = yield* BotUsageLedger;
      const botId = BotId.make("bot-partial-fallback");
      const threadId = ThreadId.make("thread-partial-fallback");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);

      const result = yield* runtime.generate(threadId, {
        operation: "generate",
        prompt: PROMPT,
        count: 3,
      });

      assert.equal(result.status, "completed");

      if (result.status !== "completed") return;
      assert.deepEqual(
        result.artifacts.map((artifact) => artifact.provider),
        ["chatgpt", "grok", "grok"],
      );
      assert.deepEqual(
        adapters.grok.calls.map((call) => call.count),
        [2],
      );
      const messages = yield* generatedMessages(threadId);
      assert.equal(messages[0]?.attachments?.length, 3);
      const usage = yield* ledger.summarize(botId);
      assert.deepEqual(usage.entries.map((entry) => String(entry.provider)).sort(), [
        "chatgpt",
        "grok",
      ]);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("routes a Claude bot to ChatGPT and a Codex bot to Grok by override", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt"), grok: fakeAdapter("grok") };

    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const claudeBot = BotId.make("bot-claude-chatgpt");
      const codexBot = BotId.make("bot-codex-grok");
      const claudeThread = ThreadId.make("thread-claude");
      const codexThread = ThreadId.make("thread-codex");
      yield* createProject;
      yield* createBot(claudeBot, "claudeAgent", "chatgpt");
      yield* createBot(codexBot, "codex", "grok");
      yield* createBotThread(claudeThread, claudeBot);
      yield* createBotThread(codexThread, codexBot);

      const claude = yield* runtime.generate(claudeThread, {
        operation: "generate",
        prompt: PROMPT,
      });

      const codex = yield* runtime.generate(codexThread, { operation: "generate", prompt: PROMPT });

      assert.equal(claude.status === "completed" && claude.provider, "chatgpt");
      assert.equal(codex.status === "completed" && codex.provider, "grok");
      assert.equal(adapters.chatgpt.calls.length, 1);
      assert.equal(adapters.grok.calls.length, 1);
    }).pipe(
      Effect.provide(
        testLayer({
          baseDir: tempBaseDir(),
          adapters,
          // The global default is Grok, so the Claude bot proves its override wins.
          imageGeneration: { ...bothEnabled, defaultProvider: "grok", fallbackOrder: ["grok"] },
        }),
      ),
    );
  });

  it.effect("uses the global default without an override and honors an explicit provider", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt"), grok: fakeAdapter("grok") };

    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const botId = BotId.make("bot-default");
      const threadId = ThreadId.make("thread-default");
      yield* createProject;
      yield* createBot(botId, "codex", null);
      yield* createBotThread(threadId, botId);

      const byDefault = yield* runtime.generate(threadId, {
        operation: "generate",
        prompt: PROMPT,
      });

      const explicit = yield* runtime.generate(threadId, {
        operation: "generate",
        prompt: PROMPT,
        provider: "grok",
      });

      assert.equal(byDefault.status === "completed" && byDefault.provider, "chatgpt");
      assert.equal(explicit.status === "completed" && explicit.provider, "grok");
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("falls back after a provider failure and records provider health", () => {
    const adapters = {
      chatgpt: fakeAdapter("chatgpt", new ImageAdapterFailure("provider-failed", "Down.")),
      grok: fakeAdapter("grok"),
    };

    const subscriptions = fakeSubscriptions();

    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const botId = BotId.make("bot-fallback");
      const threadId = ThreadId.make("thread-fallback");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);

      const result = yield* runtime.generate(threadId, { operation: "generate", prompt: PROMPT });

      assert.deepEqual(result.status === "completed" && result.attempts, [
        { provider: "chatgpt", outcome: "provider-failed" },
        { provider: "grok", outcome: "completed" },
      ]);
      assert.deepEqual(subscriptions.failures, [["chatgpt", "Down."]]);
      assert.deepEqual(subscriptions.successes, ["grok"]);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters, subscriptions })));
  });

  it.effect("skips a revoked provider without calling it", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt"), grok: fakeAdapter("grok") };

    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const botId = BotId.make("bot-revoked");
      const threadId = ThreadId.make("thread-revoked");
      yield* createProject;
      yield* createBot(botId, "codex", null);
      yield* createBotThread(threadId, botId);

      const result = yield* runtime.generate(threadId, { operation: "generate", prompt: PROMPT });

      assert.equal(result.status === "completed" && result.provider, "grok");
      assert.equal(adapters.chatgpt.calls.length, 0);
    }).pipe(
      Effect.provide(
        testLayer({
          baseDir: tempBaseDir(),
          adapters,
          subscriptions: fakeSubscriptions({ "openai-codex": "revoked" }),
        }),
      ),
    );
  });

  it.effect("asks before sending a user's image to a fallback provider", () => {
    const adapters = {
      chatgpt: fakeAdapter("chatgpt", new ImageAdapterFailure("timeout", "Slow.")),
      grok: fakeAdapter("grok"),
    };

    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const botId = BotId.make("bot-edit");
      const threadId = ThreadId.make("thread-edit");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);
      const upload = yield* saveUserImage(threadId);
      yield* sendUserMessage(threadId, "edit", [upload.attachment]);

      const asked = yield* runtime.generate(threadId, { operation: "edit", prompt: PROMPT });
      assert.equal(asked.status, "needs-consent");
      assert.equal(asked.status === "needs-consent" && asked.provider, "grok");
      assert.equal(adapters.grok.calls.length, 0);
      assert.equal((yield* generatedMessages(threadId)).length, 0);

      const agreed = yield* runtime.generate(threadId, {
        operation: "edit",
        prompt: PROMPT,
        allowProvider: "grok",
      });

      assert.equal(agreed.status === "completed" && agreed.provider, "grok");
      assert.deepEqual(adapters.grok.calls[0]!.inputImages, [
        { mimeType: "image/png", bytes: upload.bytes },
      ]);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });

  it.effect("does not edit an older image after a text-only message", () => {
    const adapters = { chatgpt: fakeAdapter("chatgpt"), grok: fakeAdapter("grok") };

    return Effect.gen(function* () {
      const runtime = yield* ImageGenerationRuntime;
      const botId = BotId.make("bot-stale-edit");
      const threadId = ThreadId.make("thread-stale-edit");
      yield* createProject;
      yield* createBot(botId, "claudeAgent", null);
      yield* createBotThread(threadId, botId);
      const upload = yield* saveUserImage(threadId);
      yield* sendUserMessage(threadId, "stale-image", [upload.attachment]);
      yield* sendUserMessage(threadId, "text-only");

      const result = yield* runtime.generate(threadId, { operation: "edit", prompt: PROMPT });

      assert.equal(result.status === "failed" && result.kind, "invalid-request");
      assert.equal(adapters.chatgpt.calls.length, 0);
    }).pipe(Effect.provide(testLayer({ baseDir: tempBaseDir(), adapters })));
  });
});
