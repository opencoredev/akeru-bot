/**
 * Image request routing.
 *
 * Picks the provider for one image request independent of the calling bot's
 * chat model: an explicit `provider` pins the request to that provider, else
 * the bot's `imageProvider` override, else the global default, then the
 * global fallback order. Fallback only follows availability and provider
 * failures (`IMAGE_FALLBACK_FAILURE_KINDS`). Invalid or unsupported requests
 * stop immediately, and an edit never sends the user's input images to a
 * provider other than the intended one without explicit `allowProvider`
 * consent.
 */
import {
  IMAGE_FALLBACK_FAILURE_KINDS,
  type ImageGenerationAttempt,
  type ImageGenerationFailureKind,
  type ImageGenerationRequest,
  type ImageGenerationSettings,
  type ImageProviderId,
} from "@akeru/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  ImageAdapterFailure,
  type ImageAdapterInputImage,
  type ImageAdapterOutput,
  type ImageProviderAdapter,
  unsupportedReason,
} from "./adapters.ts";

export const IMAGE_PROVIDER_LABELS: Readonly<Record<ImageProviderId, string>> = {
  chatgpt: "ChatGPT",
  grok: "Grok",
};

/** Bounded per-provider wait; image calls routinely take tens of seconds. */
export const IMAGE_REQUEST_TIMEOUT = Duration.seconds(150);

export type ImageProviderAvailability =
  | { readonly state: "available" }
  | {
      readonly state: "unavailable";
      readonly kind: "unavailable" | "revoked";
      readonly message: string;
    };

export interface ImageRouteInput {
  readonly request: ImageGenerationRequest;
  readonly inputImages: ReadonlyArray<ImageAdapterInputImage>;
  readonly settings: ImageGenerationSettings;
  readonly botOverride: ImageProviderId | null;
  readonly availability: (provider: ImageProviderId) => ImageProviderAvailability;
  readonly adapters: Readonly<Record<ImageProviderId, ImageProviderAdapter>>;
  readonly timeout?: Duration.Input;
  /** Called after every real provider call, for request health. */
  readonly onAttempt?: (
    provider: ImageProviderId,
    outcome: { readonly ok: true } | { readonly ok: false; readonly failure: ImageAdapterFailure },
  ) => Effect.Effect<void>;
  /** Called once per successful provider request, before another request can fail. */
  readonly onOutput?: (
    provider: ImageProviderId,
    output: ImageAdapterOutput,
    requestIndex: number,
  ) => Effect.Effect<void>;
}

export interface ImageRoutePart {
  readonly provider: ImageProviderId;
  readonly output: ImageAdapterOutput;
}

export type ImageRouteResult =
  | {
      readonly status: "completed";
      readonly provider: ImageProviderId;
      readonly parts: ReadonlyArray<ImageRoutePart>;
      readonly attempts: ReadonlyArray<ImageGenerationAttempt>;
    }
  | {
      readonly status: "failed";
      readonly kind: ImageGenerationFailureKind;
      readonly message: string;
      readonly parts: ReadonlyArray<ImageRoutePart>;
      readonly attempts: ReadonlyArray<ImageGenerationAttempt>;
    }
  | {
      readonly status: "needs-consent";
      readonly provider: ImageProviderId;
      readonly message: string;
      readonly parts: ReadonlyArray<ImageRoutePart>;
      readonly attempts: ReadonlyArray<ImageGenerationAttempt>;
    };

function providerEnabled(settings: ImageGenerationSettings, provider: ImageProviderId): boolean {
  return provider === "chatgpt" ? settings.chatgptEnabled : settings.grokEnabled;
}

/** The provider a request is meant for, and the ordered candidates to try. */
export function imageRoutePlan(input: {
  readonly settings: ImageGenerationSettings;
  readonly botOverride: ImageProviderId | null;
  readonly explicit: ImageProviderId | undefined;
}): { readonly intended: ImageProviderId | null; readonly candidates: ImageProviderId[] } {
  if (input.explicit) return { intended: input.explicit, candidates: [input.explicit] };
  const ordered = [
    input.botOverride,
    input.settings.defaultProvider,
    ...input.settings.fallbackOrder,
  ].filter((provider): provider is ImageProviderId => provider !== null);
  const candidates = [...new Set(ordered)];
  return { intended: candidates[0] ?? null, candidates };
}

const runAdapter = (
  adapter: ImageProviderAdapter,
  request: Parameters<ImageProviderAdapter["run"]>[0],
  timeout: Duration.Input,
) =>
  Effect.tryPromise({
    try: (signal) => adapter.run(request, signal),
    catch: (cause) =>
      cause instanceof ImageAdapterFailure
        ? cause
        : new ImageAdapterFailure(
            "provider-failed",
            `${IMAGE_PROVIDER_LABELS[adapter.provider]} image request failed.`,
          ),
  }).pipe(
    Effect.timeoutOption(timeout),
    Effect.flatMap((output) =>
      Option.isSome(output)
        ? Effect.succeed(output.value)
        : Effect.fail(
            new ImageAdapterFailure(
              "timeout",
              `${IMAGE_PROVIDER_LABELS[adapter.provider]} did not return an image in time.`,
            ),
          ),
    ),
  );

/**
 * Runs one image request across the routed providers. Interrupting the
 * returned effect aborts the in-flight provider request.
 */
export const routeImageRequest = Effect.fn("routeImageRequest")(function* (
  input: ImageRouteInput,
): Effect.fn.Return<ImageRouteResult> {
  const { request, settings } = input;
  const plan = imageRoutePlan({
    settings,
    botOverride: input.botOverride,
    explicit: request.provider,
  });
  const attempts: ImageGenerationAttempt[] = [];
  const parts: ImageRoutePart[] = [];
  const adapterRequest = {
    operation: request.operation,
    prompt: request.prompt,
    inputImages: input.inputImages,
    aspectRatio: request.aspectRatio,
    quality: request.quality ?? "standard",
    count: request.count ?? 1,
  } as const;

  if (plan.candidates.length === 0 || !plan.candidates.some((p) => providerEnabled(settings, p))) {
    return {
      status: "failed",
      kind: "disabled",
      message: request.provider
        ? `${IMAGE_PROVIDER_LABELS[request.provider]} image generation is turned off in Settings.`
        : "Image generation is turned off. Enable ChatGPT or Grok images in Settings.",
      attempts,
      parts,
    };
  }

  // A consented edit retry goes to the approved provider first instead of repeating the
  // provider that already failed; the rest of the plan still backs it up.
  const consented =
    input.inputImages.length > 0 && request.allowProvider
      ? plan.candidates.filter((provider) => provider === request.allowProvider)
      : [];
  const candidates = [...consented, ...plan.candidates.filter((p) => !consented.includes(p))];
  let lastFailure: { kind: ImageGenerationFailureKind; message: string } | undefined;
  let remainingCount = adapterRequest.count;
  for (const provider of candidates) {
    const label = IMAGE_PROVIDER_LABELS[provider];
    if (!providerEnabled(settings, provider)) continue;

    const availability = input.availability(provider);
    if (availability.state === "unavailable") {
      attempts.push({ provider, outcome: availability.kind });
      // An unavailable fallback cannot hide the failure of a provider that ran the request.
      lastFailure ??= { kind: availability.kind, message: availability.message };
      continue;
    }

    const adapter = input.adapters[provider];
    const providerRequest = { ...adapterRequest, count: remainingCount };
    const unsupported = unsupportedReason(label, adapter.capabilities, providerRequest);
    if (unsupported) {
      attempts.push({ provider, outcome: "unsupported" });
      // The intended provider defines the request's capability. An unsupported
      // fallback cannot erase an earlier availability or provider failure.
      if (provider === plan.intended) {
        return { status: "failed", kind: "unsupported", message: unsupported, attempts, parts };
      }
      lastFailure ??= { kind: "unsupported", message: unsupported };
      continue;
    }

    if (
      input.inputImages.length > 0 &&
      provider !== plan.intended &&
      request.allowProvider !== provider
    ) {
      const intendedLabel = plan.intended
        ? IMAGE_PROVIDER_LABELS[plan.intended]
        : "The selected provider";
      return {
        status: "needs-consent",
        provider,
        message: `${intendedLabel} could not take this edit. Ask the user whether their image may be sent to ${label}; if they agree, retry with allowProvider "${provider}".`,
        attempts,
        parts,
      };
    }

    const callCount = provider === "chatgpt" ? remainingCount : 1;
    for (let index = 0; index < callCount; index += 1) {
      const outcome = yield* runAdapter(
        adapter,
        { ...providerRequest, count: provider === "chatgpt" ? 1 : remainingCount },
        input.timeout ?? IMAGE_REQUEST_TIMEOUT,
      ).pipe(
        Effect.map((output) => ({ ok: true as const, output })),
        Effect.catch((failure: ImageAdapterFailure) =>
          Effect.succeed({ ok: false as const, failure }),
        ),
      );
      if (input.onAttempt) {
        yield* input.onAttempt(
          provider,
          outcome.ok ? { ok: true } : { ok: false, failure: outcome.failure },
        );
      }
      if (!outcome.ok || outcome.output.images.length === 0) {
        const failure = outcome.ok
          ? new ImageAdapterFailure("provider-failed", `${label} returned no image.`)
          : outcome.failure;
        attempts.push({ provider, outcome: failure.kind });
        lastFailure = { kind: failure.kind, message: failure.message };
        if (!IMAGE_FALLBACK_FAILURE_KINDS.has(failure.kind)) {
          return { status: "failed", ...lastFailure, attempts, parts };
        }
        break;
      }
      const output = { ...outcome.output, images: outcome.output.images.slice(0, remainingCount) };
      if (input.onOutput) yield* input.onOutput(provider, output, parts.length);
      parts.push({ provider, output });
      attempts.push({ provider, outcome: "completed" });
      remainingCount -= output.images.length;
      if (remainingCount === 0) {
        return { status: "completed", provider: parts[0]!.provider, parts, attempts };
      }
    }
  }

  return {
    status: "failed",
    kind: lastFailure?.kind ?? "unavailable",
    message: lastFailure?.message ?? "No image provider is available.",
    attempts,
    parts,
  };
});
