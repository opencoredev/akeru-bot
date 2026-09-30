// @effect-diagnostics nodeBuiltinImport:off
/**
 * Runs one image tool call for a chat.
 *
 * Every provider reaches this through the same entry: MCP-driven providers
 * (Claude, Grok, OpenCode) through the `generate_image` MCP tool, and the
 * Mastra controller (Codex, Kimi) through `runImageGenerationTool`, which
 * backs the `GenerateImage` catalog tool. The runtime resolves the calling
 * bot, routes the
 * request with `routeImageRequest`, saves each image as a local chat
 * attachment, posts the attachments into the chat as an assistant message,
 * and records usage against the calling bot.
 *
 * Prompts and image bytes stay inside this module and the provider request.
 * The tool result, events, logs, and usage rows only carry metadata.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  AkeruUsageReservationId,
  type BotId,
  type ChatImageAttachment,
  CommandId,
  decodeImageGenerationRequest,
  type ImageArtifact,
  type ImageGenerationResult,
  type ImageProviderId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionBotRepository } from "../persistence/Services/ProjectionBots.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SubscriptionAuthService } from "../subscription-auth/service.ts";
import { BotUsageLedger } from "../usage/BotUsageLedger.ts";
import {
  type ImageAdapterFailure,
  type ImageAdapterInputImage,
  type ImageProviderAdapter,
  makeChatGptImageAdapter,
  makeGrokImageAdapter,
} from "./adapters.ts";
import { sniffImage } from "./imageBytes.ts";
import { type ImageProviderAvailability, routeImageRequest } from "./router.ts";

const EXTENSION_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
} as const;

const SUBSCRIPTION_BY_IMAGE_PROVIDER = { chatgpt: "openai-codex", grok: "xai" } as const;

export interface ImageGenerationRuntimeShape {
  /**
   * Runs one decoded-or-raw tool input for `threadId`. Never fails: every
   * problem becomes a `failed` result the calling bot can read. Interrupting
   * the effect aborts the provider request.
   */
  readonly generate: (threadId: ThreadId, input: unknown) => Effect.Effect<ImageGenerationResult>;
  /** Interrupts every in-flight image request for the chat. */
  readonly cancelThread: (threadId: ThreadId) => Effect.Effect<void>;
}

export class ImageGenerationRuntime extends Context.Service<
  ImageGenerationRuntime,
  ImageGenerationRuntimeShape
>()("akeru-bot/image-generation/ImageGenerationRuntime") {}

/** The subscription store methods the runtime reads for availability and health. */
export type ImageSubscriptionAuth = Pick<
  SubscriptionAuthService,
  "statuses" | "recordImageGenerationSuccess" | "recordImageRequestFailure"
>;

export interface ImageGenerationRuntimeOptions {
  /** Test seams; production builds both from the subscription store. */
  readonly adapters?: Readonly<Record<ImageProviderId, ImageProviderAdapter>>;
  readonly subscriptionAuth?: ImageSubscriptionAuth;
  /** Per-attempt provider timeout; defaults to the router's `IMAGE_REQUEST_TIMEOUT`. */
  readonly requestTimeout?: Duration.Input;
}

function failed(
  kind: Extract<ImageGenerationResult, { status: "failed" }>["kind"],
  message: string,
): ImageGenerationResult {
  return { status: "failed", kind, message, attempts: [] };
}

function persistImage(input: {
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly bytes: Uint8Array;
  readonly mimeType: keyof typeof EXTENSION_BY_MIME;
  readonly index: number;
}): ChatImageAttachment | null {
  const attachmentId = createAttachmentId(input.threadId);
  if (!attachmentId) return null;
  const extension = EXTENSION_BY_MIME[input.mimeType];
  const finalPath = NodePath.join(input.attachmentsDir, `${attachmentId}${extension}`);
  const temporaryPath = `${finalPath}.part`;
  try {
    NodeFS.mkdirSync(input.attachmentsDir, { recursive: true });
    NodeFS.writeFileSync(temporaryPath, input.bytes, { flag: "wx" });
    NodeFS.renameSync(temporaryPath, finalPath);
  } catch {
    NodeFS.rmSync(temporaryPath, { force: true });
    return null;
  }
  return {
    type: "image",
    id: attachmentId,
    name: `generated-image-${input.index + 1}${extension}`,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
  };
}

export const makeImageGenerationRuntime = Effect.fn("makeImageGenerationRuntime")(function* (
  options: ImageGenerationRuntimeOptions = {},
) {
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const messages = yield* ProjectionThreadMessageRepository;
  const bots = yield* ProjectionBotRepository;
  const serverSettings = yield* ServerSettingsService;
  const usageLedger = yield* BotUsageLedger;
  const sharedStore = yield* Effect.cached(
    SubscriptionAuthService.forSecretsDir(config.secretsDir),
  );
  const subscriptionAuth = options.subscriptionAuth ?? (yield* sharedStore);
  const adapters = options.adapters ?? {
    chatgpt: makeChatGptImageAdapter({ subscriptionAuth: yield* sharedStore }),
    grok: makeGrokImageAdapter({ subscriptionAuth: yield* sharedStore }),
  };
  const inFlight = new Map<string, Set<Fiber.Fiber<ImageGenerationResult>>>();
  // Requests run detached from their caller, so shutdown interrupts them explicitly
  // before anything else can write an attachment into a closing server.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...inFlight.values()].flatMap((fibers) => [...fibers]),
      Fiber.interrupt,
      {
        discard: true,
      },
    ),
  );

  const availability = (provider: ImageProviderId): ImageProviderAvailability => {
    const label = provider === "chatgpt" ? "ChatGPT" : "Grok";
    const subscription = subscriptionAuth
      .statuses()
      .find((status) => status.provider === SUBSCRIPTION_BY_IMAGE_PROVIDER[provider]);
    if (!subscription?.connected) {
      return {
        state: "unavailable",
        kind: "unavailable",
        message: `${label} is not connected. Connect it in Settings.`,
      };
    }
    if (subscription.health === "revoked") {
      return {
        state: "unavailable",
        kind: "revoked",
        message: `${label} access was revoked. Reconnect it in Settings.`,
      };
    }
    return { state: "available" };
  };

  const recordAttempt = (
    provider: ImageProviderId,
    outcome: { readonly ok: true } | { readonly ok: false; readonly failure: ImageAdapterFailure },
  ) =>
    Effect.sync(() => {
      if (outcome.ok) {
        subscriptionAuth.recordImageGenerationSuccess(provider);
        return;
      }
      // Cancellation and bad requests say nothing about the provider's health.
      const kind = outcome.failure.kind;
      if (kind === "cancelled" || kind === "invalid-request" || kind === "unsupported") return;
      subscriptionAuth.recordImageRequestFailure(
        provider,
        outcome.failure.message,
        undefined,
        kind === "revoked" ? "revoked" : "request",
      );
    });

  /** Reads the requested input images, which must be image attachments in this chat. */
  const resolveInputImages = (threadId: ThreadId, requested: ReadonlyArray<string> | undefined) =>
    Effect.gen(function* () {
      const threadMessages = yield* messages.listByThreadId({ threadId });
      const images = threadMessages.flatMap((message) =>
        (message.attachments ?? []).flatMap((attachment) =>
          attachment.type === "image" ? [{ attachment, role: message.role }] : [],
        ),
      );
      let selected: ReadonlyArray<ChatImageAttachment>;
      if (requested) {
        const byId = new Map(images.map(({ attachment }) => [attachment.id, attachment]));
        const missing = requested.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          return { ok: false as const, message: "Input images must be images from this chat." };
        }
        selected = requested.map((id) => byId.get(id)!);
      } else {
        // Only the latest user message counts, so a text-only follow-up never edits an older image.
        const latestUser = threadMessages.findLast((message) => message.role === "user");
        selected = (latestUser?.attachments ?? []).filter(
          (attachment): attachment is ChatImageAttachment => attachment.type === "image",
        );
        if (selected.length === 0) {
          return {
            ok: false as const,
            message: "The latest message has no image to edit. Name the images in inputImages.",
          };
        }
      }
      const loaded: ImageAdapterInputImage[] = [];
      for (const attachment of selected) {
        const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        const bytes = path ? yield* Effect.sync(() => readImageFile(path)) : null;
        if (!bytes) {
          return { ok: false as const, message: "An input image is no longer available." };
        }
        loaded.push({ mimeType: attachment.mimeType, bytes });
      }
      return { ok: true as const, images: loaded };
    });

  const postAttachments = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly generationId: string;
    readonly attachments: ReadonlyArray<ChatImageAttachment>;
  }) =>
    Effect.gen(function* () {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const messageId = MessageId.make(`image-generation-${input.generationId}`);
      yield* engine
        .dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(`server:image-generation:${input.generationId}`),
          threadId: input.threadId,
          messageId,
          delta: "",
          attachments: [...input.attachments],
          ...(input.turnId ? { turnId: input.turnId } : {}),
          createdAt,
        })
        .pipe(
          // No message references the files when this post fails, so nothing else would remove them.
          Effect.onError(() =>
            Effect.sync(() => {
              for (const attachment of input.attachments) {
                const path = resolveAttachmentPath({
                  attachmentsDir: config.attachmentsDir,
                  attachment,
                });
                if (path) NodeFS.rmSync(path, { force: true });
              }
            }),
          ),
        );
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`server:image-generation-complete:${input.generationId}`),
        threadId: input.threadId,
        messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt,
      });
    });

  const recordUsage = (input: {
    readonly botId: BotId;
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly usageId: string;
    readonly provider: ImageProviderId;
    readonly model: string | undefined;
    readonly usage: { inputTokens: number; outputTokens: number; reasoningTokens: number | null };
  }) =>
    Effect.gen(function* () {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* usageLedger.recordMeasurement({
        reservationId: AkeruUsageReservationId.make(`image:${input.usageId}`),
        sourceKey: `image:${input.usageId}`,
        botId: input.botId,
        threadId: input.threadId,
        turnId: input.turnId,
        category: "tool",
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        reasoningTokens: input.usage.reasoningTokens,
        provider: ProviderDriverKind.make(input.provider),
        model: input.model ?? null,
        createdAt,
      });
    });

  const run = (threadId: ThreadId, rawInput: unknown) =>
    Effect.gen(function* () {
      const decoded = decodeImageGenerationRequest(rawInput);
      if (!decoded.ok) return failed("invalid-request", decoded.message);
      const request = decoded.request;

      const shell = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(shell)) return failed("invalid-request", "This chat no longer exists.");
      const thread = shell.value;
      const botId =
        thread.latestTurn?.respondingBotId ?? thread.respondingBotId ?? thread.botId ?? null;
      const bot = botId ? yield* bots.getById({ botId }) : Option.none();
      const turnId = thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null;
      const settings = (yield* serverSettings.getSettings).imageGeneration;

      const inputImages =
        request.operation === "edit" || request.inputImages
          ? yield* resolveInputImages(threadId, request.inputImages)
          : { ok: true as const, images: [] };
      if (!inputImages.ok) return failed("invalid-request", inputImages.message);

      const generationId = NodeCrypto.randomUUID();
      const routed = yield* routeImageRequest({
        request,
        inputImages: inputImages.images,
        settings,
        botOverride: Option.isSome(bot) ? bot.value.imageProvider : null,
        availability,
        adapters,
        ...(options.requestTimeout ? { timeout: options.requestTimeout } : {}),
        onAttempt: recordAttempt,
        onOutput: (provider, output, requestIndex) =>
          botId
            ? recordUsage({
                botId,
                threadId,
                turnId,
                usageId: `${generationId}:${requestIndex}`,
                provider,
                model: output.model,
                usage: output.usage ?? {
                  inputTokens: 0,
                  outputTokens: 0,
                  reasoningTokens: null,
                },
              }).pipe(
                Effect.catch(() =>
                  Effect.logWarning("Could not record image generation usage.", { threadId }),
                ),
              )
            : Effect.void,
      });

      const artifacts: ImageArtifact[] = [];
      const attachments: ChatImageAttachment[] = [];
      for (const part of routed.parts) {
        for (const bytes of part.output.images) {
          const sniffed = sniffImage(bytes);
          if (!sniffed || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) continue;
          const attachment = persistImage({
            attachmentsDir: config.attachmentsDir,
            threadId,
            bytes,
            mimeType: sniffed.mimeType,
            index: attachments.length,
          });
          if (!attachment) continue;
          attachments.push(attachment);
          artifacts.push({
            attachmentId: attachment.id,
            mimeType: sniffed.mimeType,
            width: sniffed.width,
            height: sniffed.height,
            sizeBytes: bytes.byteLength,
            provider: part.provider,
            ...(part.output.model ? { model: part.output.model } : {}),
          });
        }
      }
      if (attachments.length > 0) {
        yield* postAttachments({ threadId, turnId, generationId, attachments });
      }
      if (routed.status !== "completed") {
        const { parts: _parts, ...result } = routed;
        return result;
      }
      const requested = request.count ?? 1;
      if (attachments.length < requested) {
        return {
          status: "failed",
          kind: "provider-failed",
          message:
            attachments.length === 0
              ? "The provider returned no usable image."
              : `Only ${attachments.length} of ${requested} images were usable. They are posted in the chat.`,
          attempts: routed.attempts,
        } satisfies ImageGenerationResult;
      }

      return {
        status: "completed",
        provider: routed.provider,
        ...(routed.parts[0]?.output.model ? { model: routed.parts[0].output.model } : {}),
        artifacts,
        attempts: routed.attempts,
      } satisfies ImageGenerationResult;
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(failed("provider-failed", "Image generation could not finish.")),
      ),
      Effect.onInterrupt(() =>
        Effect.logInfo("Image generation cancelled.", { threadId: String(threadId) }),
      ),
    );

  const generate: ImageGenerationRuntimeShape["generate"] = (threadId, input) =>
    Effect.gen(function* () {
      const fiber = yield* run(threadId, input).pipe(Effect.forkDetach);
      const key = String(threadId);
      const fibers = inFlight.get(key) ?? new Set();
      fibers.add(fiber);
      inFlight.set(key, fibers);
      const exit = yield* Fiber.await(fiber).pipe(
        Effect.onInterrupt(() => Fiber.interrupt(fiber)),
        Effect.ensuring(
          Effect.sync(() => {
            fibers.delete(fiber);
            if (fibers.size === 0) inFlight.delete(key);
          }),
        ),
      );
      return exit._tag === "Success"
        ? exit.value
        : failed("cancelled", "Image generation was cancelled.");
    });

  const cancelThread: ImageGenerationRuntimeShape["cancelThread"] = (threadId) =>
    Effect.suspend(() => {
      const fibers = [...(inFlight.get(String(threadId)) ?? [])];
      return Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber), { discard: true });
    });

  return ImageGenerationRuntime.of({ generate, cancelThread });
});

function readImageFile(path: string): Uint8Array | null {
  try {
    const bytes = NodeFS.readFileSync(path);
    return bytes.byteLength > 0 && bytes.byteLength <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      ? new Uint8Array(bytes)
      : null;
  } catch {
    return null;
  }
}

let activeImageGenerationRuntime: ImageGenerationRuntimeShape | undefined;

/**
 * Publishes a runtime for tool handlers until the scope closes. MCP handlers
 * run without the server's runtime services (route-only test layers build
 * `/mcp` alone), so they reach the runtime through this slot.
 */
export const activateImageGenerationRuntime = (runtime: ImageGenerationRuntimeShape) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      activeImageGenerationRuntime = runtime;
    }),
    () =>
      Effect.sync(() => {
        if (activeImageGenerationRuntime === runtime) activeImageGenerationRuntime = undefined;
      }),
  );

export const layerWith = (options: ImageGenerationRuntimeOptions = {}) =>
  Layer.effect(
    ImageGenerationRuntime,
    makeImageGenerationRuntime(options).pipe(
      Effect.tap((runtime) => activateImageGenerationRuntime(runtime)),
    ),
  ).pipe(Layer.provide(ProjectionThreadMessageRepositoryLive));

export const layer = layerWith();

/** Runs the image tool through the active runtime; the entry point for tool registrations. */
export const runImageGenerationTool = (
  threadId: ThreadId,
  input: unknown,
): Effect.Effect<ImageGenerationResult> =>
  activeImageGenerationRuntime
    ? activeImageGenerationRuntime.generate(threadId, input)
    : Effect.succeed(failed("unavailable", "Image generation is not running on this server."));

/** Cancels in-flight image requests for a chat, for turn interrupts. */
export const cancelActiveImageGenerations = (threadId: ThreadId): Effect.Effect<void> =>
  activeImageGenerationRuntime ? activeImageGenerationRuntime.cancelThread(threadId) : Effect.void;
