import * as Predicate from "effect/Predicate";
import { botId, makeTest } from "./testUtils/voiceProviders.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { VoiceCallManager } from "./VoiceCallManager.ts";
import { voiceFailure } from "./VoiceAdapters.ts";

it.effect("uses explicit transcription selection without provider fallback", () => {
  const used: string[] = [];
  return Effect.gen(function* () {
    const manager = yield* VoiceCallManager;
    yield* manager.connect("openai", "openai-key");
    const missing = yield* Effect.result(manager.start({ botId }, "owner"));
    assert.equal(missing._tag, "Failure");
    if (Predicate.isTagged(missing, "Failure"))
      assert.equal(missing.failure.reason, "provider-unavailable");
    assert.deepEqual(yield* manager.get, { status: "idle" });
    yield* manager.connect("elevenlabs", "eleven-key");
    const call = yield* manager.start({ botId }, "owner");
    yield* manager.transcribe(
      {
        operationId: "transcribe",
        callId: call.call.callId,
        audioBase64: "YQ==",
        mimeType: "audio/wav",
      },
      "owner",
    );
    assert.deepEqual(used, ["elevenlabs:eleven-key"]);
  }).pipe(
    Effect.provide(
      makeTest(
        {
          transcribe: async (provider, key) => {
            used.push(`${provider}:${key}`);
            return { text: "hello" };
          },
        },
        { transcriptionProvider: "elevenlabs" },
      ),
    ),
  );
});

it.effect("starts OpenAI realtime with its own key and selected voice", () => {
  const used: string[] = [];
  return Effect.gen(function* () {
    const manager = yield* VoiceCallManager;
    yield* manager.connect("openai", "api-key");
    assert.equal((yield* Effect.result(manager.start({ botId }, "owner")))._tag, "Failure");
    const call = yield* manager.start({ botId, sdp: "offer" }, "owner");
    assert.equal(call.transport, "webrtc");
    assert.equal(call.answerSdp, "answer");
    assert.deepEqual(used, ["api-key:offer:marin"]);
    const invalid = yield* Effect.result(
      manager.transcribe(
        {
          operationId: "audio",
          callId: call.call.callId,
          audioBase64: "YQ==",
          mimeType: "audio/wav",
        },
        "owner",
      ),
    );
    assert.equal(invalid._tag, "Failure");
  }).pipe(
    Effect.provide(
      makeTest(
        {
          negotiate: async (key, sdp, _instructions, voice) => {
            used.push(`${key}:${sdp}:${voice}`);
            return "answer";
          },
        },
        { provider: "openai", openaiVoice: "marin" },
      ),
    ),
  );
});

it.effect("releases the lock after invalid voice validation and sanitizes adapter errors", () =>
  Effect.gen(function* () {
    const manager = yield* VoiceCallManager;
    yield* manager.connect("openai", "key");
    const result = yield* Effect.result(manager.start({ botId }, "owner"));
    assert.equal(result._tag, "Failure");
    if (Predicate.isTagged(result, "Failure")) assert.notInclude(result.failure.message, "private");
    assert.deepEqual(yield* manager.get, { status: "idle" });
    yield* manager.disconnect("openai");
  }).pipe(
    Effect.provide(
      makeTest({
        validateVoice: async () => {
          throw new Error("private provider body and secret");
        },
      }),
    ),
  ),
);

it.effect("releases a pending realtime call and key lock on request interruption", () => {
  const began = Promise.withResolvers<void>();
  let aborted = false;
  return Effect.gen(function* () {
    const manager = yield* VoiceCallManager;
    yield* manager.connect("openai", "key");
    const fiber = yield* manager.start({ botId, sdp: "offer" }, "owner").pipe(Effect.forkChild);
    yield* Effect.promise(() => began.promise);
    yield* Fiber.interrupt(fiber);
    assert.isTrue(aborted);
    assert.deepEqual(yield* manager.get, { status: "idle" });
    yield* manager.disconnect("openai");
  }).pipe(
    Effect.provide(
      makeTest(
        {
          negotiate: async (_key, _sdp, _instructions, _voice, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(voiceFailure("cancelled"));
                },
                { once: true },
              );
              began.resolve();
            }),
        },
        { provider: "openai" },
      ),
    ),
  );
});

for (const cancellation of [
  "hangup",
  "cancel",
  "disconnect",
  "provider-disconnect",
  "interrupt",
] as const) {
  it.effect(`aborts in-flight audio on ${cancellation}`, () => {
    const began = Promise.withResolvers<void>();
    let aborted = false;
    return Effect.gen(function* () {
      const manager = yield* VoiceCallManager;
      yield* manager.connect("openai", "key");
      const call = cancellation === "hangup" ? yield* manager.start({ botId }, "owner") : undefined;
      const fiber = yield* manager
        .synthesize(
          { operationId: "audio", ...(call ? { callId: call.call.callId } : {}), text: "Hello" },
          "owner",
        )
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => began.promise);
      const duplicate = yield* Effect.result(
        manager.synthesize({ operationId: "audio", text: "Duplicate" }, "owner"),
      );
      assert.equal(duplicate._tag, "Failure");
      if (Predicate.isTagged(duplicate, "Failure")) assert.equal(duplicate.failure.reason, "busy");
      assert.deepEqual(yield* manager.cancel("audio", "other"), { cancelled: false });
      if (cancellation === "hangup" && call) yield* manager.hangup(call.call.callId, "owner");
      else if (cancellation === "cancel")
        assert.deepEqual(yield* manager.cancel("audio", "owner"), { cancelled: true });
      else if (cancellation === "disconnect") yield* manager.hangupOwner("owner");
      else if (cancellation === "provider-disconnect") yield* manager.disconnect("openai");
      else yield* Fiber.interrupt(fiber);
      if (cancellation !== "interrupt") {
        const result = yield* Fiber.join(fiber);
        assert.equal(result._tag, "Failure");
        if (Predicate.isTagged(result, "Failure")) assert.equal(result.failure.reason, "cancelled");
      }
      assert.isTrue(aborted);
      assert.deepEqual(yield* manager.cancel("audio", "owner"), { cancelled: false });
    }).pipe(
      Effect.provide(
        makeTest({
          synthesize: async (_provider, _key, _voice, _text, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(voiceFailure("cancelled"));
                },
                { once: true },
              );
              began.resolve();
            }),
        }),
      ),
    );
  });
}
