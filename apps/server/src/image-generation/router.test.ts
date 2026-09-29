import { describe, expect, it } from "@effect/vitest";
import type {
  ImageGenerationRequest,
  ImageGenerationSettings,
  ImageProviderId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import {
  CHATGPT_IMAGE_CAPABILITIES,
  GROK_IMAGE_CAPABILITIES,
  ImageAdapterFailure,
  type ImageAdapterRequest,
  type ImageProviderAdapter,
} from "./adapters.ts";
import {
  IMAGE_REQUEST_TIMEOUT,
  type ImageProviderAvailability,
  type ImageRouteInput,
  imageRoutePlan,
  routeImageRequest,
} from "./router.ts";
import { pngBytes } from "./testImages.ts";

const bothEnabled: ImageGenerationSettings = {
  chatgptEnabled: true,
  grokEnabled: true,
  defaultProvider: "chatgpt",
  fallbackOrder: ["chatgpt", "grok"],
};

interface FakeAdapter extends ImageProviderAdapter {
  readonly calls: ImageAdapterRequest[];
  readonly signals: AbortSignal[];
}

function fakeAdapter(
  provider: ImageProviderId,
  behavior: "ok" | ImageAdapterFailure | "hang" = "ok",
): FakeAdapter {
  const calls: ImageAdapterRequest[] = [];
  const signals: AbortSignal[] = [];
  return {
    provider,
    capabilities: provider === "chatgpt" ? CHATGPT_IMAGE_CAPABILITIES : GROK_IMAGE_CAPABILITIES,
    calls,
    signals,
    run: (request, signal) => {
      calls.push(request);
      signals.push(signal);
      if (behavior === "ok") {
        return Promise.resolve({ images: [pngBytes(16, 16)], model: `${provider}-model` });
      }
      if (behavior === "hang") return new Promise(() => {});
      return Promise.reject(behavior);
    },
  };
}

const available = (): ImageProviderAvailability => ({ state: "available" });

function routeInput(
  overrides: Partial<Omit<ImageRouteInput, "request">> & {
    readonly request?: Partial<ImageGenerationRequest>;
  } = {},
): ImageRouteInput & { adapters: Record<ImageProviderId, FakeAdapter> } {
  const adapters = (overrides.adapters ?? {
    chatgpt: fakeAdapter("chatgpt"),
    grok: fakeAdapter("grok"),
  }) as Record<ImageProviderId, FakeAdapter>;
  return {
    settings: bothEnabled,
    botOverride: null,
    availability: available,
    inputImages: [],
    ...overrides,
    adapters,
    request: { operation: "generate", prompt: "A lighthouse at dusk", ...overrides.request },
  };
}

const editImage = [{ mimeType: "image/png", bytes: pngBytes(4, 4) }];

describe("imageRoutePlan", () => {
  it("orders bot override, then default, then fallback order", () => {
    expect(
      imageRoutePlan({ settings: bothEnabled, botOverride: "grok", explicit: undefined }),
    ).toEqual({ intended: "grok", candidates: ["grok", "chatgpt"] });
    expect(
      imageRoutePlan({ settings: bothEnabled, botOverride: null, explicit: undefined }),
    ).toEqual({
      intended: "chatgpt",
      candidates: ["chatgpt", "grok"],
    });
    expect(
      imageRoutePlan({ settings: bothEnabled, botOverride: "chatgpt", explicit: "grok" }),
    ).toEqual({ intended: "grok", candidates: ["grok"] });
  });
});

describe("routeImageRequest", () => {
  it.effect("routes to ChatGPT only when only ChatGPT is enabled", () =>
    Effect.gen(function* () {
      const input = routeInput({
        settings: { ...bothEnabled, grokEnabled: false, defaultProvider: null },
      });
      const result = yield* routeImageRequest(input);
      expect(result.status).toBe("completed");
      expect(result.status === "completed" && result.provider).toBe("chatgpt");
      expect(input.adapters.grok.calls).toHaveLength(0);
    }),
  );

  it.effect("routes to Grok only when only Grok is enabled", () =>
    Effect.gen(function* () {
      const input = routeInput({
        settings: { ...bothEnabled, chatgptEnabled: false },
        request: { aspectRatio: "16:9" },
      });
      const result = yield* routeImageRequest(input);
      expect(result.status === "completed" && result.provider).toBe("grok");
      expect(input.adapters.chatgpt.calls).toHaveLength(0);
    }),
  );

  it.effect("uses the bot override over the global default", () =>
    Effect.gen(function* () {
      const input = routeInput({ botOverride: "grok" });
      const result = yield* routeImageRequest(input);
      expect(result.status === "completed" && result.provider).toBe("grok");
      expect(input.adapters.chatgpt.calls).toHaveLength(0);
    }),
  );

  it.effect("reports disabled when no provider is enabled", () =>
    Effect.gen(function* () {
      const result = yield* routeImageRequest(
        routeInput({ settings: { ...bothEnabled, chatgptEnabled: false, grokEnabled: false } }),
      );
      expect(result).toMatchObject({ status: "failed", kind: "disabled", attempts: [] });
    }),
  );

  it.effect("skips an unavailable or revoked provider and records why", () =>
    Effect.gen(function* () {
      const input = routeInput({
        availability: (provider) =>
          provider === "chatgpt"
            ? { state: "unavailable", kind: "revoked", message: "Reconnect ChatGPT." }
            : { state: "available" },
      });
      const result = yield* routeImageRequest(input);
      expect(result).toMatchObject({
        status: "completed",
        provider: "grok",
        attempts: [
          { provider: "chatgpt", outcome: "revoked" },
          { provider: "grok", outcome: "completed" },
        ],
      });
      expect(input.adapters.chatgpt.calls).toHaveLength(0);
    }),
  );

  it.effect("reports the last availability failure when nothing can run", () =>
    Effect.gen(function* () {
      const result = yield* routeImageRequest(
        routeInput({
          availability: () => ({
            state: "unavailable",
            kind: "unavailable",
            message: "Not connected.",
          }),
        }),
      );
      expect(result).toMatchObject({
        status: "failed",
        kind: "unavailable",
        message: "Not connected.",
      });
    }),
  );

  it.effect("preserves an unavailable intended provider when the fallback cannot edit", () =>
    Effect.gen(function* () {
      const input = routeInput({
        inputImages: [...editImage, ...editImage],
        request: { operation: "edit", inputImages: ["a", "b"] },
        availability: (provider) =>
          provider === "chatgpt"
            ? { state: "unavailable", kind: "revoked", message: "Reconnect ChatGPT." }
            : { state: "available" },
      });
      const result = yield* routeImageRequest(input);
      expect(result).toMatchObject({
        status: "failed",
        kind: "revoked",
        message: "Reconnect ChatGPT.",
        attempts: [
          { provider: "chatgpt", outcome: "revoked" },
          { provider: "grok", outcome: "unsupported" },
        ],
      });
      expect(input.adapters.grok.calls).toHaveLength(0);
    }),
  );

  it.effect("falls back after a provider failure", () =>
    Effect.gen(function* () {
      const outcomes: Array<[ImageProviderId, boolean]> = [];
      const input = routeInput({
        adapters: {
          chatgpt: fakeAdapter("chatgpt", new ImageAdapterFailure("provider-failed", "boom")),
          grok: fakeAdapter("grok"),
        },
        onAttempt: (provider, outcome) => Effect.sync(() => outcomes.push([provider, outcome.ok])),
      });
      const result = yield* routeImageRequest(input);
      expect(result.status === "completed" && result.provider).toBe("grok");
      expect(outcomes).toEqual([
        ["chatgpt", false],
        ["grok", true],
      ]);
    }),
  );

  it.effect("keeps a successful image when a later ChatGPT request fails", () =>
    Effect.gen(function* () {
      const chatgpt = fakeAdapter("chatgpt");
      const run = chatgpt.run;
      let calls = 0;
      const input = routeInput({
        request: { count: 2, provider: "chatgpt" },
        adapters: {
          chatgpt: {
            ...chatgpt,
            run: (request, signal) => {
              calls += 1;
              return calls === 2
                ? Promise.reject(new ImageAdapterFailure("provider-failed", "Second failed."))
                : run(request, signal);
            },
          },
          grok: fakeAdapter("grok"),
        },
      });
      const result = yield* routeImageRequest(input);
      expect(result).toMatchObject({ status: "failed", kind: "provider-failed" });
      expect(result.parts).toHaveLength(1);
      expect(calls).toBe(2);
      expect(input.adapters.grok.calls).toHaveLength(0);
    }),
  );

  it.effect("asks fallback for only the images ChatGPT did not produce", () =>
    Effect.gen(function* () {
      const chatgpt = fakeAdapter("chatgpt");
      const run = chatgpt.run;
      let calls = 0;
      const fallbackCounts: number[] = [];
      const input = routeInput({
        request: { count: 3 },
        adapters: {
          chatgpt: {
            ...chatgpt,
            run: (request, signal) => {
              calls += 1;
              if (calls === 2) {
                chatgpt.calls.push(request);
                return Promise.reject(new ImageAdapterFailure("provider-failed", "Second failed."));
              }
              return run(request, signal);
            },
          },
          grok: {
            ...fakeAdapter("grok"),
            run: (request) => {
              fallbackCounts.push(request.count);
              return Promise.resolve({
                images: Array.from({ length: request.count }, () => pngBytes(16, 16)),
                model: "grok-model",
              });
            },
          },
        },
      });
      const result = yield* routeImageRequest(input);
      expect(result.status).toBe("completed");
      expect(input.adapters.chatgpt.calls.map((call) => call.count)).toEqual([1, 1]);
      expect(fallbackCounts).toEqual([2]);
      expect(result.parts[1]?.output.images).toHaveLength(2);
      expect(result.parts.map((part) => part.provider)).toEqual(["chatgpt", "grok"]);
    }),
  );

  it.effect("does not fall back after an invalid request", () =>
    Effect.gen(function* () {
      const input = routeInput({
        adapters: {
          chatgpt: fakeAdapter("chatgpt", new ImageAdapterFailure("invalid-request", "Refused.")),
          grok: fakeAdapter("grok"),
        },
      });
      const result = yield* routeImageRequest(input);
      expect(result).toMatchObject({
        status: "failed",
        kind: "invalid-request",
        message: "Refused.",
      });
      expect(input.adapters.grok.calls).toHaveLength(0);
    }),
  );

  it.effect("never falls back from an explicit provider", () =>
    Effect.gen(function* () {
      const input = routeInput({
        request: { provider: "chatgpt" },
        adapters: {
          chatgpt: fakeAdapter("chatgpt", new ImageAdapterFailure("provider-failed", "Down.")),
          grok: fakeAdapter("grok"),
        },
      });
      const result = yield* routeImageRequest(input);
      expect(result).toMatchObject({ status: "failed", kind: "provider-failed" });
      expect(input.adapters.grok.calls).toHaveLength(0);
    }),
  );

  it.effect("rejects an edit the intended provider cannot serve", () =>
    Effect.gen(function* () {
      const input = routeInput({
        botOverride: "grok",
        inputImages: [...editImage, ...editImage],
        request: { operation: "edit", inputImages: ["a", "b"] },
      });
      const result = yield* routeImageRequest(input);
      expect(result).toMatchObject({ status: "failed", kind: "unsupported" });
      expect(input.adapters.grok.calls).toHaveLength(0);
      expect(input.adapters.chatgpt.calls).toHaveLength(0);
    }),
  );

  it.effect("asks before sending an edit's images to a fallback provider", () =>
    Effect.gen(function* () {
      const failing = {
        chatgpt: fakeAdapter("chatgpt", new ImageAdapterFailure("timeout", "Slow.")),
        grok: fakeAdapter("grok"),
      };
      const withoutConsent = routeInput({
        adapters: failing,
        inputImages: editImage,
        request: { operation: "edit", inputImages: ["a"] },
      });
      const result = yield* routeImageRequest(withoutConsent);
      expect(result).toMatchObject({ status: "needs-consent", provider: "grok" });
      expect(failing.grok.calls).toHaveLength(0);

      const withConsent = routeInput({
        adapters: failing,
        inputImages: editImage,
        request: { operation: "edit", inputImages: ["a"], allowProvider: "grok" },
      });
      const retried = yield* routeImageRequest(withConsent);
      expect(retried.status === "completed" && retried.provider).toBe("grok");
      expect(failing.grok.calls[0]!.inputImages).toHaveLength(1);
    }),
  );

  it.effect("times out a slow provider and falls back", () =>
    Effect.gen(function* () {
      const input = routeInput({
        adapters: { chatgpt: fakeAdapter("chatgpt", "hang"), grok: fakeAdapter("grok") },
      });
      const fiber = yield* routeImageRequest(input).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(IMAGE_REQUEST_TIMEOUT);
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({
        status: "completed",
        provider: "grok",
        attempts: [
          { provider: "chatgpt", outcome: "timeout" },
          { provider: "grok", outcome: "completed" },
        ],
      });
      expect(input.adapters.chatgpt.signals[0]!.aborted).toBe(true);
    }),
  );

  it.effect("aborts the provider request when the caller cancels", () =>
    Effect.gen(function* () {
      const input = routeInput({
        adapters: { chatgpt: fakeAdapter("chatgpt", "hang"), grok: fakeAdapter("grok") },
      });
      const fiber = yield* routeImageRequest(input).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(5));
      expect(input.adapters.chatgpt.calls).toHaveLength(1);
      yield* Fiber.interrupt(fiber);
      expect(input.adapters.chatgpt.signals[0]!.aborted).toBe(true);
      expect(input.adapters.grok.calls).toHaveLength(0);
    }),
  );
});
