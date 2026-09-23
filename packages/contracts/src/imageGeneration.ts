/**
 * Image generation provider contracts.
 *
 * Image generation rides on subscription credentials the user already
 * connected for chat providers (`openai-codex` for ChatGPT, `xai` for Grok).
 * This contract covers provider rows, global settings, and the nullable
 * per-bot selection. Nothing here generates an image yet — per milestone-1
 * decision D5 the generation tool ships separately, so `lastGenerationAt`
 * has no producer and always reports as absent until that work lands.
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

export const ImageProviderOperation = Schema.Literals(["generate"]);
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
  /** ISO time of the last successful image generation. Absent until M7. */
  lastGenerationAt: Schema.optional(IsoDateTime),
  lastFailure: Schema.optional(
    Schema.Struct({ at: IsoDateTime, message: TrimmedNonEmptyString }),
  ),
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
