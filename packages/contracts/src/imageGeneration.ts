/**
 * Image generation provider contracts.
 *
 * Image generation rides on subscription credentials the user already
 * connected for chat providers (`openai-codex` for ChatGPT, `xai` for Grok).
 * This contract covers provider rows, global settings, the nullable per-bot
 * selection, and the typed generate/edit request every bot uses regardless
 * of its chat model. Results carry artifact metadata only; image bytes live
 * in the attachment store and never cross orchestration events.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The image provider identity shown to users; distinct from subscription ids. */
export const ImageProviderId = Schema.Literals(["chatgpt", "grok"]);
export type ImageProviderId = typeof ImageProviderId.Type;

export const IMAGE_PROVIDER_IDS = ["chatgpt", "grok"] as const;

export function isImageProviderId(value: string): value is ImageProviderId {
  return (IMAGE_PROVIDER_IDS as readonly string[]).includes(value);
}

export const ImageProviderOperation = Schema.Literals(["generate", "edit"]);
export type ImageProviderOperation = typeof ImageProviderOperation.Type;

export const ImageProviderHealth = Schema.Literals([
  "missing",
  "detected",
  "healthy",
  "expired",
  "revoked",
  "failed",
  "failed-first-request",
  "recovered",
  "unsupported",
  "disabled",
]);
export type ImageProviderHealth = typeof ImageProviderHealth.Type;

/**
 * One row in the Image generation settings surface. Health only reaches
 * "healthy" after the health test performs a real provider request; it never
 * reports success optimistically.
 */
export const ImageProviderStatus = Schema.Struct({
  provider: ImageProviderId,
  label: TrimmedNonEmptyString,
  /** Whether the underlying subscription credential exists. */
  connected: Schema.Boolean,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  health: ImageProviderHealth,
  operations: Schema.Array(ImageProviderOperation).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** ISO time of the last successful image generation. */
  lastGenerationAt: Schema.optional(IsoDateTime),
  lastFailure: Schema.optional(Schema.Struct({ at: IsoDateTime, message: TrimmedNonEmptyString })),
  repairAction: Schema.optional(TrimmedNonEmptyString),
  healthTest: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(["not-run", "passed", "failed"]),
      checkedAt: Schema.optional(IsoDateTime),
    }),
  ),
});
export type ImageProviderStatus = typeof ImageProviderStatus.Type;

/**
 * Global image-generation settings. `defaultProvider` and `fallbackOrder`
 * are only meaningful when the matching providers are enabled; the server
 * normalizes them on write so a disabled provider can never be the default.
 */
export const ImageGenerationSettings = Schema.Struct({
  chatgptEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  grokEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultProvider: Schema.NullOr(ImageProviderId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  fallbackOrder: Schema.Array(ImageProviderId).pipe(
    Schema.withDecodingDefault(Effect.succeed(["chatgpt", "grok"])),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type ImageGenerationSettings = typeof ImageGenerationSettings.Type;

export const ImageGenerationSettingsPatch = Schema.Struct({
  chatgptEnabled: Schema.optionalKey(Schema.Boolean),
  grokEnabled: Schema.optionalKey(Schema.Boolean),
  defaultProvider: Schema.optionalKey(Schema.NullOr(ImageProviderId)),
  fallbackOrder: Schema.optionalKey(
    Schema.Array(ImageProviderId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(2),
      Schema.isUnique(),
    ),
  ),
});
export type ImageGenerationSettingsPatch = typeof ImageGenerationSettingsPatch.Type;

export const ImageProviderListResult = Schema.Struct({
  providers: Schema.Array(ImageProviderStatus),
});
export type ImageProviderListResult = typeof ImageProviderListResult.Type;

export const ImageProviderHealthTestInput = Schema.Struct({
  provider: ImageProviderId,
});
export type ImageProviderHealthTestInput = typeof ImageProviderHealthTestInput.Type;

export class ImageGenerationError extends Schema.TaggedErrorClass<ImageGenerationError>()(
  "ImageGenerationError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const ImageAspectRatio = Schema.Literals([
  "1:1",
  "3:2",
  "2:3",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
]);
export type ImageAspectRatio = typeof ImageAspectRatio.Type;

/** Provider-neutral quality tier; adapters map it to their own size/quality knobs. */
export const ImageQuality = Schema.Literals(["standard", "high"]);
export type ImageQuality = typeof ImageQuality.Type;

export const IMAGE_GENERATION_MAX_COUNT = 4;
export const IMAGE_EDIT_MAX_INPUT_IMAGES = 4;
export const IMAGE_PROMPT_MAX_CHARS = 4_000;

/**
 * The one image tool input every bot sends. `inputImages` are attachment ids
 * from the calling chat; an edit without them uses the images on the most
 * recent user message. `allowProvider` is the provider the user agreed to
 * send their input images to after a `needs-consent` result.
 */
export const ImageGenerationRequest = Schema.Struct({
  operation: ImageProviderOperation,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(IMAGE_PROMPT_MAX_CHARS)),
  inputImages: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(IMAGE_EDIT_MAX_INPUT_IMAGES),
      Schema.isUnique(),
    ),
  ),
  aspectRatio: Schema.optionalKey(ImageAspectRatio),
  quality: Schema.optionalKey(ImageQuality),
  count: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: IMAGE_GENERATION_MAX_COUNT })),
  ),
  provider: Schema.optionalKey(ImageProviderId),
  allowProvider: Schema.optionalKey(ImageProviderId),
});
export type ImageGenerationRequest = typeof ImageGenerationRequest.Type;

const decodeImageGenerationRequestSync = Schema.decodeUnknownSync(ImageGenerationRequest);

/** Strict decode: unknown option keys are rejected rather than ignored. */
export function decodeImageGenerationRequest(
  input: unknown,
):
  | { readonly ok: true; readonly request: ImageGenerationRequest }
  | { readonly ok: false; readonly message: string } {
  try {
    return {
      ok: true,
      request: decodeImageGenerationRequestSync(input, { onExcessProperty: "error" }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Invalid image request: ${detail.slice(0, 400)}` };
  }
}

/** A completed image saved as a local Akeru attachment. */
export const ImageArtifact = Schema.Struct({
  attachmentId: TrimmedNonEmptyString,
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
  width: Schema.Int,
  height: Schema.Int,
  sizeBytes: Schema.Int,
  provider: ImageProviderId,
  model: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ImageArtifact = typeof ImageArtifact.Type;

/**
 * Normalized failure kinds. Only `unavailable`, `revoked`, `provider-failed`,
 * and `timeout` trigger fallback; invalid or unsupported requests never do.
 */
export const ImageGenerationFailureKind = Schema.Literals([
  "invalid-request",
  "unsupported",
  "disabled",
  "unavailable",
  "revoked",
  "provider-failed",
  "timeout",
  "cancelled",
]);
export type ImageGenerationFailureKind = typeof ImageGenerationFailureKind.Type;

export const IMAGE_FALLBACK_FAILURE_KINDS: ReadonlySet<ImageGenerationFailureKind> = new Set([
  "unavailable",
  "revoked",
  "provider-failed",
  "timeout",
]);

export const ImageGenerationAttempt = Schema.Struct({
  provider: ImageProviderId,
  outcome: Schema.Union([Schema.Literal("completed"), ImageGenerationFailureKind]),
});
export type ImageGenerationAttempt = typeof ImageGenerationAttempt.Type;

export const ImageGenerationResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    provider: ImageProviderId,
    model: Schema.optionalKey(TrimmedNonEmptyString),
    artifacts: Schema.Array(ImageArtifact),
    attempts: Schema.Array(ImageGenerationAttempt),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    kind: ImageGenerationFailureKind,
    message: TrimmedNonEmptyString,
    attempts: Schema.Array(ImageGenerationAttempt),
  }),
  Schema.Struct({
    status: Schema.Literal("needs-consent"),
    /** The provider the input images would be sent to. */
    provider: ImageProviderId,
    message: TrimmedNonEmptyString,
    attempts: Schema.Array(ImageGenerationAttempt),
  }),
]);
export type ImageGenerationResult = typeof ImageGenerationResult.Type;
