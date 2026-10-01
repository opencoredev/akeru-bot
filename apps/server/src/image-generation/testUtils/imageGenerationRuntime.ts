// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  BotId,
  type ChatImageAttachment,
  CommandId,
  type ImageGenerationSettings,
  type ImageProviderId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionBotRepositoryLive } from "../../persistence/Layers/ProjectionBots.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import * as SqlitePersistence from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BotUsageLedgerLive } from "../../usage/BotUsageLedger.ts";
import {
  CHATGPT_IMAGE_CAPABILITIES,
  GROK_IMAGE_CAPABILITIES,
  ImageAdapterFailure,
  type ImageAdapterRequest,
  type ImageProviderAdapter,
} from "../adapters.ts";
import { type ImageSubscriptionAuth, layerWith } from "../ImageGenerationRuntime.ts";
import { jpegBytes, pngBytes } from "../testImages.ts";

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
export {
  createdAt,
  projectId,
  modelSelection,
  PROMPT,
  type FakeAdapter,
  type Behavior,
  fakeAdapter,
  type FakeSubscriptions,
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
};
