// @effect-diagnostics globalFetch:off
/**
 * Image provider adapters.
 *
 * Each adapter turns the provider-neutral request into one documented,
 * authenticated subscription call and returns raw image bytes plus whatever
 * model and usage metadata the provider exposes. Nothing here persists,
 * logs, or forwards bytes or prompts; the runtime owns artifacts.
 *
 * - ChatGPT uses the ChatGPT sign-in through the Codex responses transport
 *   Akeru's Codex chat already uses, with the `image_generation` tool. An
 *   OpenAI API key does not qualify: the ChatGPT row is subscription-only.
 * - Grok uses the xAI Imagine endpoints (`/v1/images/generations` and
 *   `/v1/images/edits`) with the connected xAI credential.
 *
 * Failures are thrown as `ImageAdapterFailure` with a normalized kind so the
 * router can decide whether fallback is allowed.
 */
import {
  DEFAULT_TEXT_GENERATION_MODEL,
  type ImageAspectRatio,
  type ImageGenerationFailureKind,
  type ImageProviderId,
  type ImageProviderOperation,
  type ImageQuality,
} from "@t3tools/contracts";

import type { SubscriptionAuthService } from "../subscription-auth/service.ts";
import { ImageResponseTooLargeError, readBoundedText } from "./boundedResponse.ts";

export const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";
export const GROK_IMAGE_MODEL = "grok-imagine-image-2.0";

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ImageAdapterInputImage {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ImageAdapterRequest {
  readonly operation: ImageProviderOperation;
  readonly prompt: string;
  readonly inputImages: ReadonlyArray<ImageAdapterInputImage>;
  readonly aspectRatio: ImageAspectRatio | undefined;
  readonly quality: ImageQuality;
  readonly count: number;
}

export interface ImageAdapterUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number | null;
}

export interface ImageAdapterOutput {
  readonly images: ReadonlyArray<Uint8Array>;
  readonly model?: string;
  readonly usage?: ImageAdapterUsage;
}

export class ImageAdapterFailure extends Error {
  readonly kind: ImageGenerationFailureKind;
  constructor(kind: ImageGenerationFailureKind, message: string) {
    super(message);
    this.name = "ImageAdapterFailure";
    this.kind = kind;
  }
}

export interface ImageOperationCapability {
  /** Empty means the provider takes no aspect-ratio option for this operation. */
  readonly aspectRatios: ReadonlyArray<ImageAspectRatio>;
  readonly maxCount: number;
  readonly maxInputImages: number;
}

export interface ImageProviderCapabilities {
  readonly generate: ImageOperationCapability;
  readonly edit: ImageOperationCapability | null;
}

export interface ImageProviderAdapter {
  readonly provider: ImageProviderId;
  readonly capabilities: ImageProviderCapabilities;
  readonly run: (request: ImageAdapterRequest, signal: AbortSignal) => Promise<ImageAdapterOutput>;
}

const CHATGPT_SIZES: Partial<Record<ImageAspectRatio, string>> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
};

export const CHATGPT_IMAGE_CAPABILITIES: ImageProviderCapabilities = {
  generate: { aspectRatios: ["1:1", "3:2", "2:3"], maxCount: 4, maxInputImages: 0 },
  edit: { aspectRatios: ["1:1", "3:2", "2:3"], maxCount: 4, maxInputImages: 4 },
};

export const GROK_IMAGE_CAPABILITIES: ImageProviderCapabilities = {
  generate: {
    aspectRatios: ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"],
    maxCount: 4,
    maxInputImages: 0,
  },
  // The documented edit call takes one source image and no size options.
  edit: { aspectRatios: [], maxCount: 1, maxInputImages: 1 },
};

export function operationsFor(
  capabilities: ImageProviderCapabilities,
): ReadonlyArray<ImageProviderOperation> {
  return capabilities.edit ? ["generate", "edit"] : ["generate"];
}

/**
 * Explains why a provider cannot serve this request, or undefined when it
 * can. Checked before any network call; an unsupported combination is the
 * caller's problem and never triggers fallback.
 */
export function unsupportedReason(
  label: string,
  capabilities: ImageProviderCapabilities,
  request: Pick<ImageAdapterRequest, "operation" | "aspectRatio" | "count" | "inputImages">,
): string | undefined {
  const capability = request.operation === "edit" ? capabilities.edit : capabilities.generate;
  if (!capability) return `${label} does not support image editing.`;
  if (request.operation === "edit" && request.inputImages.length === 0) {
    return "Image editing needs at least one input image.";
  }
  if (request.operation === "generate" && request.inputImages.length > 0) {
    return "Input images are only accepted for edits.";
  }
  if (request.inputImages.length > capability.maxInputImages) {
    return `${label} accepts at most ${capability.maxInputImages} input image${capability.maxInputImages === 1 ? "" : "s"} for edits.`;
  }
  if (request.count > capability.maxCount) {
    return `${label} returns at most ${capability.maxCount} image${capability.maxCount === 1 ? "" : "s"} per ${request.operation}.`;
  }
  if (request.aspectRatio !== undefined && !capability.aspectRatios.includes(request.aspectRatio)) {
    return capability.aspectRatios.length === 0
      ? `${label} does not accept an aspect ratio for ${request.operation}s.`
      : `${label} supports aspect ratios ${capability.aspectRatios.join(", ")}.`;
  }
  return undefined;
}

function dataUrl(image: ImageAdapterInputImage): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

function decodeBase64Image(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 ? new Uint8Array(bytes) : undefined;
}

/** Maps an HTTP status to a normalized kind without echoing the provider body. */
export function failureForStatus(label: string, status: number): ImageAdapterFailure {
  if (status === 401 || status === 403) {
    return new ImageAdapterFailure(
      "revoked",
      `${label} rejected the connected account (${status}).`,
    );
  }
  if (status === 400 || status === 422) {
    return new ImageAdapterFailure(
      "invalid-request",
      `${label} refused this image request (${status}). Try a different prompt.`,
    );
  }
  if (status === 404) {
    return new ImageAdapterFailure(
      "unavailable",
      `${label} image generation is not available for this account (${status}).`,
    );
  }
  return new ImageAdapterFailure("provider-failed", `${label} image request failed (${status}).`);
}

function rethrowFetchFailure(label: string, cause: unknown): never {
  if (cause instanceof ImageAdapterFailure) throw cause;
  if (cause instanceof ImageResponseTooLargeError) {
    throw new ImageAdapterFailure("provider-failed", cause.message);
  }
  if (cause instanceof Error && cause.name === "AbortError") {
    throw new ImageAdapterFailure("cancelled", `${label} image request was cancelled.`);
  }
  throw new ImageAdapterFailure("provider-failed", `${label} could not be reached.`);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function* sseEvents(body: string): Generator<Record<string, unknown>> {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed && typeof parsed === "object") yield parsed as Record<string, unknown>;
    } catch {
      // Ignore keep-alive fragments; missing images are reported below.
    }
  }
}

const MODERATION_CODE = /moderation|content_policy|safety/i;

/** Parses one Codex responses stream into generated images and usage. */
export function parseChatGptImageStream(body: string): {
  readonly images: Uint8Array[];
  readonly usage?: ImageAdapterUsage;
} {
  const images: Uint8Array[] = [];
  let usage: ImageAdapterUsage | undefined;
  for (const event of sseEvents(body)) {
    const type = event.type;
    if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "image_generation_call") {
        const image = decodeBase64Image(item.result);
        if (image) images.push(image);
      }
      continue;
    }
    if (type === "response.failed" || type === "error") {
      const response = event.response as Record<string, unknown> | undefined;
      const error = (response?.error ?? event.error ?? event) as Record<string, unknown>;
      const code = `${String(error.code ?? "")} ${String(error.type ?? "")}`;
      throw MODERATION_CODE.test(code)
        ? new ImageAdapterFailure(
            "invalid-request",
            "ChatGPT declined this image request under its content policy.",
          )
        : new ImageAdapterFailure("provider-failed", "ChatGPT could not finish the image.");
    }
    if (type === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      const raw = response?.usage as Record<string, unknown> | undefined;
      const inputTokens = finiteNumber(raw?.input_tokens);
      const outputTokens = finiteNumber(raw?.output_tokens);
      if (inputTokens !== undefined && outputTokens !== undefined) {
        const details = raw?.output_tokens_details as Record<string, unknown> | undefined;
        usage = {
          inputTokens,
          outputTokens,
          reasoningTokens: finiteNumber(details?.reasoning_tokens) ?? null,
        };
      }
    }
  }
  return usage ? { images, usage } : { images };
}

function addUsage(
  left: ImageAdapterUsage | undefined,
  right: ImageAdapterUsage | undefined,
): ImageAdapterUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens:
      left.reasoningTokens === null && right.reasoningTokens === null
        ? null
        : (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
  };
}

const CHATGPT_INSTRUCTIONS =
  "Create the requested image with the image_generation tool. Do not answer with text.";

export function makeChatGptImageAdapter(deps: {
  readonly subscriptionAuth: Pick<
    SubscriptionAuthService,
    "getOpenAICodexAccess" | "getApiKeyCredential"
  >;
  readonly fetchFn?: FetchFn;
}): ImageProviderAdapter {
  const fetchFn = deps.fetchFn ?? fetch;
  const label = "ChatGPT";
  return {
    provider: "chatgpt",
    capabilities: CHATGPT_IMAGE_CAPABILITIES,
    run: async (request, signal) => {
      let access: Awaited<ReturnType<SubscriptionAuthService["getOpenAICodexAccess"]>>;
      try {
        access = await deps.subscriptionAuth.getOpenAICodexAccess();
      } catch {
        throw new ImageAdapterFailure("revoked", "The ChatGPT sign-in needs to be reconnected.");
      }
      if (!access) {
        throw new ImageAdapterFailure(
          "unavailable",
          deps.subscriptionAuth.getApiKeyCredential("openai-codex")
            ? "ChatGPT images need a ChatGPT account sign-in; an OpenAI API key is not used."
            : "No ChatGPT account is connected.",
        );
      }
      const size = CHATGPT_SIZES[request.aspectRatio ?? "1:1"] ?? "1024x1024";
      const images: Uint8Array[] = [];
      let usage: ImageAdapterUsage | undefined;
      // One image per call keeps each stream small and cancellation prompt.
      for (let index = 0; index < request.count; index += 1) {
        let body: string;
        try {
          const response = await fetchFn(CHATGPT_RESPONSES_URL, {
            method: "POST",
            redirect: "error",
            signal,
            headers: {
              Authorization: `Bearer ${access.accessToken}`,
              "ChatGPT-Account-ID": access.accountId,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              originator: "akeru",
            },
            body: JSON.stringify({
              model: DEFAULT_TEXT_GENERATION_MODEL,
              instructions: CHATGPT_INSTRUCTIONS,
              stream: true,
              store: false,
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [
                    { type: "input_text", text: request.prompt },
                    ...request.inputImages.map((image) => ({
                      type: "input_image",
                      image_url: dataUrl(image),
                    })),
                  ],
                },
              ],
              tools: [
                {
                  type: "image_generation",
                  size,
                  quality: request.quality === "high" ? "high" : "medium",
                  output_format: "png",
                },
              ],
              tool_choice: { type: "image_generation" },
            }),
          });
          if (!response.ok) throw failureForStatus(label, response.status);
          body = await readBoundedText(response, label);
        } catch (cause) {
          rethrowFetchFailure(label, cause);
        }
        const parsed = parseChatGptImageStream(body);
        if (parsed.images.length === 0) {
          throw new ImageAdapterFailure("provider-failed", "ChatGPT returned no image.");
        }
        images.push(...parsed.images.slice(0, 1));
        usage = addUsage(usage, parsed.usage);
      }
      return usage ? { images, usage } : { images };
    },
  };
}

export function makeGrokImageAdapter(deps: {
  readonly subscriptionAuth: Pick<
    SubscriptionAuthService,
    "getAccessToken" | "getApiKeyCredential"
  >;
  readonly fetchFn?: FetchFn;
}): ImageProviderAdapter {
  const fetchFn = deps.fetchFn ?? fetch;
  const label = "Grok";
  return {
    provider: "grok",
    capabilities: GROK_IMAGE_CAPABILITIES,
    run: async (request, signal) => {
      let token: string | undefined;
      try {
        token = await deps.subscriptionAuth.getAccessToken("xai");
      } catch {
        throw new ImageAdapterFailure("revoked", "The Grok account needs to be reconnected.");
      }
      if (!token) throw new ImageAdapterFailure("unavailable", "No Grok account is connected.");
      const baseUrl = (
        deps.subscriptionAuth.getApiKeyCredential("xai")?.baseUrl ?? XAI_DEFAULT_BASE_URL
      ).replace(/\/+$/, "");
      const edit = request.operation === "edit";
      const firstImage = request.inputImages[0];
      const body = edit
        ? {
            model: GROK_IMAGE_MODEL,
            prompt: request.prompt,
            response_format: "b64_json",
            ...(firstImage ? { image: { url: dataUrl(firstImage), type: "image_url" } } : {}),
          }
        : {
            model: GROK_IMAGE_MODEL,
            prompt: request.prompt,
            n: request.count,
            response_format: "b64_json",
            resolution: request.quality === "high" ? "2k" : "1k",
            ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
          };
      let payload: unknown;
      try {
        const response = await fetchFn(`${baseUrl}/images/${edit ? "edits" : "generations"}`, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw failureForStatus(label, response.status);
        payload = JSON.parse(await readBoundedText(response, label));
      } catch (cause) {
        rethrowFetchFailure(label, cause);
      }
      const record = (payload ?? {}) as Record<string, unknown>;
      const data = Array.isArray(record.data) ? (record.data as Record<string, unknown>[]) : [];
      const images = data
        .map((entry) => decodeBase64Image(entry?.b64_json))
        .filter((image): image is Uint8Array => image !== undefined)
        .slice(0, request.count);
      if (images.length === 0) {
        throw new ImageAdapterFailure("provider-failed", "Grok returned no image.");
      }
      const model =
        typeof record.model === "string" && record.model ? record.model : GROK_IMAGE_MODEL;
      return { images, model };
    },
  };
}
