// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  BotId,
  type ChatImageAttachment,
  CommandId,
  GroupId,
  type ImageGenerationSettings,
  type ImageProviderId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionBotRepositoryLive } from "../persistence/Layers/ProjectionBots.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BotUsageLedger, BotUsageLedgerLive } from "../usage/BotUsageLedger.ts";
import {
  CHATGPT_IMAGE_CAPABILITIES,
  GROK_IMAGE_CAPABILITIES,
  ImageAdapterFailure,
  type ImageAdapterRequest,
  type ImageProviderAdapter,
} from "./adapters.ts";
import {
  ImageGenerationRuntime,
  type ImageSubscriptionAuth,
  layerWith,
  makeImageGenerationRuntime,
} from "./ImageGenerationRuntime.ts";
import { base64, jpegBytes, pngBytes } from "./testImages.ts";

const createdAt = "2026-09-01T00:00:00.000Z";
const projectId = ProjectId.make("project-images");
const modelSelection = { instanceId: "codex", model: "gpt-5.6" } as never;
const PROMPT = "Private prompt about the quarterly launch poster";

interface FakeAdapter extends ImageProviderAdapter {
  readonly calls: ImageAdapterRequest[];
  readonly signals: AbortSignal[];
  readonly started: Deferred.Deferred<void>;
}

type Behavior = "ok" | "hang" | ImageAdapterFailure;

function fakeAdapter(provider: ImageProviderId, behavior: Behavior = "ok"): FakeAdapter {
  const calls: ImageAdapterRequest[] = [];
  const signals: AbortSignal[] = [];
  const started = Deferred.makeUnsafe<void>();
  return {
    provider,
    capabilities: provider === "chatgpt" ? CHATGPT_IMAGE_CAPABILITIES : GROK_IMAGE_CAPABILITIES,
    calls,
    signals,
    started,
    run: (request, signal) => {
      calls.push(request);
      signals.push(signal);
      Deferred.doneUnsafe(started, Effect.void);
      if (behavior === "hang") return new Promise(() => {});
      if (behavior !== "ok") return Promise.reject(behavior);
      return Promise.resolve({
        images: Array.from({ length: request.count }, () =>
          provider === "chatgpt" ? pngBytes(1024, 1024) : jpegBytes(1280, 720),
        ),
        model: `${provider}-image-model`,
        usage: { inputTokens: 12, outputTokens: 1_000, reasoningTokens: null },
      });
    },
  };
}

interface FakeSubscriptions extends ImageSubscriptionAuth {
  readonly successes: ImageProviderId[];
  readonly failures: Array<[ImageProviderId, string]>;
}

function fakeSubscriptions(
  state: Partial<Record<"openai-codex" | "xai", "connected" | "missing" | "revoked">> = {},
): FakeSubscriptions {
  const successes: ImageProviderId[] = [];
  const failures: Array<[ImageProviderId, string]> = [];
  const status = (provider: "openai-codex" | "xai") => {
    const value = state[provider] ?? "connected";
    return {
      provider,
      connected: value !== "missing",
      health: value === "revoked" ? ("revoked" as const) : ("healthy" as const),
      reconnectAction: "",
      healthTest: { status: "not-run" as const },
      dependentBots: [],
      dependentRoutines: [],
    };
  };
  return {
    successes,
    failures,
    statuses: () => [status("openai-codex"), status("xai")],
    recordImageGenerationSuccess: (provider) => void successes.push(provider),
    recordImageRequestFailure: (provider, message) => void failures.push([provider, message]),
  };
}

const bothEnabled: ImageGenerationSettings = {
  chatgptEnabled: true,
  grokEnabled: true,
  defaultProvider: "chatgpt",
  fallbackOrder: ["chatgpt", "grok"],
};

function testLayer(input: {
  readonly baseDir: string;
  readonly adapters: Record<ImageProviderId, FakeAdapter>;
  readonly subscriptions?: FakeSubscriptions;
  readonly imageGeneration?: ImageGenerationSettings;
}) {
  const engine = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
  );
  return layerWith({
    adapters: input.adapters,
    subscriptionAuth: input.subscriptions ?? fakeSubscriptions(),
  }).pipe(
    Layer.provideMerge(engine),
    Layer.provideMerge(BotUsageLedgerLive),
    Layer.provideMerge(ProjectionBotRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provideMerge(
      ServerSettings.layerTest({ imageGeneration: input.imageGeneration ?? bothEnabled }),
    ),
    Layer.provideMerge(SqlitePersistence.layerConfig),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

const tempBaseDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-image-runtime-"));

const createBot = (
  botId: BotId,
  provider: "claudeAgent" | "codex",
  imageProvider: ImageProviderId | null,
) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "bot.create",
      commandId: CommandId.make(`cmd-create-${botId}`),
      botId,
      name: botId,
      title: "Designer",
      avatar: { kind: "dither", seed: botId },
      engine: { provider, model: provider === "codex" ? "gpt-5.6" : "claude-opus-5.5" },
      sandbox: "local",
      runtimeMode: "full-access",
      usageCap: null,
      groupId: null,
      createdAt,
    });
    if (imageProvider) {
      yield* engine.dispatch({
        type: "bot.update",
        commandId: CommandId.make(`cmd-image-${botId}`),
        botId,
        imageProvider,
      });
    }
  });

const createProject = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId,
    title: "Images",
    workspaceRoot: "/tmp/akeru-image-runtime",
    defaultModelSelection: modelSelection,
    createdAt,
  });
});

const createBotThread = (threadId: ThreadId, botId: BotId) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${threadId}`),
      threadId,
      projectId,
      botId,
      title: "Poster",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
  });

const sendUserMessage = (
  threadId: ThreadId,
  id: string,
  attachments: ChatImageAttachment[] = [],
  group?: { readonly respondingBotId: BotId; readonly personId: AuthSessionId },
) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`cmd-turn-${id}`),
      threadId,
      ...(group ? { respondingBotId: group.respondingBotId } : {}),
      message: {
        messageId: MessageId.make(`message-${id}`),
        role: "user",
        text: "Make me an image",
        attachments,
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      ...(group ? { senderPersonId: group.personId, senderDisplayName: "Designer" } : {}),
      createdAt,
    });
  });

/** Saves a user image the way uploads land on disk. */
const saveUserImage = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const bytes = pngBytes(64, 64);
    const attachment: ChatImageAttachment = {
      type: "image",
      id: createAttachmentId(threadId)!,
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
    };
    const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!;
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, bytes);
    return { attachment, bytes };
  });

const generatedMessages = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const messages = yield* ProjectionThreadMessageRepository;
    const rows = yield* messages.listByThreadId({ threadId });
    return rows.filter((row) => row.messageId.startsWith("image-generation-"));
  });

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
