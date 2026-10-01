import * as Predicate from "effect/Predicate";
import { botId, makeTest } from "./testUtils/voiceProviders.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { ServerSettingsService } from "../serverSettings.ts";
import { VoiceCallManager } from "./VoiceCallManager.ts";
import { voiceFailure } from "./VoiceAdapters.ts";

it.effect("pins composed settings and keys, rejects key changes, and enforces ownership", () => {
  const used: string[] = [];

  return Effect.gen(function* () {
    const manager = yield* VoiceCallManager;
    const settings = yield* ServerSettingsService;
    yield* manager.connect("openai", "original");
    const started = yield* manager.start({ botId }, "owner");
    assert.equal(started.transport, "composed");
    assert.isUndefined(started.answerSdp);
    assert.equal((yield* Effect.result(manager.start({ botId }, "other")))._tag, "Failure");

    for (const action of [manager.connect("openai", "replacement"), manager.disconnect("openai")]) {
      const result = yield* Effect.result(action);
      assert.equal(result._tag, "Failure");

      if (Predicate.isTagged(result, "Failure"))
        assert.equal(result.failure.reason, "provider-in-use");
    }

    yield* manager.connect("fish", "unused-provider-key");
    yield* settings.updateSettings({
      voice: {
        enabled: false,
        synthesisProvider: "fish",
        synthesisVoices: { openai: "cedar", fish: "fish-voice" },
      },
    });

    const stolen = yield* Effect.result(
      manager.synthesize(
        { operationId: "stolen", callId: started.call.callId, text: "Hello" },
        "other",
      ),
    );

    assert.equal(stolen._tag, "Failure");

    if (Predicate.isTagged(stolen, "Failure"))
      assert.equal(stolen.failure.reason, "call-not-active");

    const standalone = yield* Effect.result(
      manager.synthesize({ operationId: "standalone", text: "Hello" }, "other"),
    );

    assert.equal(standalone._tag, "Failure");

    if (Predicate.isTagged(standalone, "Failure"))
      assert.equal(standalone.failure.reason, "call-not-active");
    yield* manager.synthesize(
      { operationId: "owned", callId: started.call.callId, text: "Hello" },
      "owner",
    );
    assert.deepEqual(used, ["openai:original:alloy"]);
    assert.deepEqual(yield* manager.providers, {
      providers: [
        { provider: "openai", connected: true, keyRejected: false },
        { provider: "elevenlabs", connected: false, keyRejected: false },
        { provider: "cartesia", connected: false, keyRejected: false },
        { provider: "fish", connected: true, keyRejected: false },
      ],
    });
    yield* manager.hangup(started.call.callId, "owner");
    yield* manager.disconnect("openai");
    assert.deepEqual(
      (yield* manager.providers).providers.find((p) => p.provider === "openai"),
      { provider: "openai", connected: false, keyRejected: false },
    );
  }).pipe(
    Effect.provide(
      makeTest({
        synthesize: async (provider, key, voice) => {
          used.push(`${provider}:${key}:${voice}`);

          return { audioBase64: "bXAz", mimeType: "audio/mpeg" };
        },
      }),
    ),
  );
});

it.effect("replaces an idle key and reports auth and quota failures without fallback", () => {
  const used: string[] = [];

  return Effect.gen(function* () {
    const manager = yield* VoiceCallManager;
    yield* manager.connect("openai", "openai-key");
    yield* manager.connect("elevenlabs", "first-key");
    yield* manager.connect("elevenlabs", "rejected-key");
    const test = yield* Effect.result(manager.test("elevenlabs"));
    assert.equal(test._tag, "Failure");

    if (Predicate.isTagged(test, "Failure")) assert.equal(test.failure.reason, "provider-auth");

    const elevenlabs = Effect.map(manager.providers, ({ providers }) =>
      providers.find((status) => status.provider === "elevenlabs"),
    );

    // Every client reads the rejection from the server until the key changes.
    assert.isTrue((yield* elevenlabs)?.keyRejected);
    const listed = yield* Effect.result(manager.listVoices("elevenlabs"));
    assert.equal(listed._tag, "Failure");

    if (Predicate.isTagged(listed, "Failure"))
      assert.equal(listed.failure.reason, "provider-quota");
    const start = yield* Effect.result(manager.start({ botId }, "owner"));
    assert.equal(start._tag, "Failure");

    if (Predicate.isTagged(start, "Failure")) {
      assert.equal(start.failure.reason, "provider-auth");
      assert.notInclude(start.failure.message, "rejected-key");
    }

    assert.deepEqual(yield* manager.get, { status: "idle" });

    const standalone = yield* Effect.result(
      manager.synthesize({ operationId: "speak", text: "Hello" }, "owner"),
    );

    assert.equal(standalone._tag, "Failure");

    if (Predicate.isTagged(standalone, "Failure"))
      assert.equal(standalone.failure.reason, "provider-auth");
    assert.deepEqual(used, [
      "test:elevenlabs:rejected-key",
      "list:elevenlabs:rejected-key",
      "validate:elevenlabs:rejected-key",
      "validate:elevenlabs:rejected-key",
    ]);
    // A replacement saved from any client clears the old key's rejection.
    yield* manager.connect("elevenlabs", "replacement-key");
    assert.isFalse((yield* elevenlabs)?.keyRejected);
  }).pipe(
    Effect.provide(
      makeTest(
        {
          test: async (provider, key) => {
            used.push(`test:${provider}:${key}`);
            throw voiceFailure("provider-auth");
          },
          listVoices: async (provider, key) => {
            used.push(`list:${provider}:${key}`);
            throw voiceFailure("provider-quota");
          },
          validateVoice: async (provider, key) => {
            used.push(`validate:${provider}:${key}`);
            throw voiceFailure("provider-auth");
          },
          synthesize: async (provider, key) => {
            used.push(`synthesize:${provider}:${key}`);

            return { audioBase64: "bXAz", mimeType: "audio/mpeg" };
          },
        },
        { synthesisProvider: "elevenlabs", synthesisVoices: { elevenlabs: "voice-id" } },
      ),
    ),
  );
});

it.effect("keeps a rejected key's verdict across a server restart", () => {
  const values = new Map<string, Uint8Array>();

  const rejected = (layer: ReturnType<typeof makeTest>) =>
    Effect.gen(function* () {
      const manager = yield* VoiceCallManager;

      return (yield* manager.providers).providers.find((p) => p.provider === "elevenlabs")
        ?.keyRejected;
    }).pipe(Effect.provide(layer));

  const failing = {
    test: async () => {
      throw voiceFailure("provider-auth");
    },
  };

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const manager = yield* VoiceCallManager;
      yield* manager.connect("elevenlabs", "rejected-key");
      yield* Effect.result(manager.test("elevenlabs"));
    }).pipe(Effect.provide(makeTest(failing, {}, values)));
    // A fresh manager over the same secrets stands in for a restarted server.
    assert.isTrue(yield* rejected(makeTest({}, {}, values)));
    yield* Effect.gen(function* () {
      const manager = yield* VoiceCallManager;
      yield* manager.connect("elevenlabs", "replacement-key");
    }).pipe(Effect.provide(makeTest({}, {}, values)));
    assert.isFalse(yield* rejected(makeTest({}, {}, values)));
  });
});

it.effect("forgets a rejection once its key is replaced", () =>
  Effect.gen(function* () {
    const manager = yield* VoiceCallManager;

    const elevenlabs = Effect.map(manager.providers, ({ providers }) =>
      providers.find((status) => status.provider === "elevenlabs"),
    );

    yield* manager.connect("elevenlabs", "rejected-key");
    yield* Effect.result(manager.test("elevenlabs"));
    // Saving the same key again keeps its verdict.
    yield* manager.connect("elevenlabs", "rejected-key");
    assert.isTrue((yield* elevenlabs)?.keyRejected);
    yield* manager.connect("elevenlabs", "replacement-key");
    yield* manager.connect("elevenlabs", "rejected-key");
    assert.isFalse((yield* elevenlabs)?.keyRejected);
  }).pipe(
    Effect.provide(
      makeTest({
        test: async () => {
          throw voiceFailure("provider-auth");
        },
      }),
    ),
  ),
);

it.effect("ignores a Test verdict for a key that was replaced mid-Test", () => {
  const pending = Promise.withResolvers<void>();
  const began = Promise.withResolvers<void>();

  return Effect.gen(function* () {
    const manager = yield* VoiceCallManager;

    const elevenlabs = Effect.map(manager.providers, ({ providers }) =>
      providers.find((status) => status.provider === "elevenlabs"),
    );

    yield* manager.connect("elevenlabs", "slow-valid-key");
    const slow = yield* Effect.forkChild(manager.test("elevenlabs"));
    yield* Effect.promise(() => began.promise);
    yield* manager.connect("elevenlabs", "rejected-key");
    yield* Effect.result(manager.test("elevenlabs"));
    assert.isTrue((yield* elevenlabs)?.keyRejected);
    pending.resolve();
    yield* Fiber.join(slow);
    assert.isTrue((yield* elevenlabs)?.keyRejected);
  }).pipe(
    Effect.provide(
      makeTest({
        test: async (_provider, key) => {
          if (key === "rejected-key") throw voiceFailure("provider-auth");
          began.resolve();
          await pending.promise;
        },
      }),
    ),
  );
});

it.effect("ignores a Test verdict from before the same key was reconnected", () => {
  const pending = Promise.withResolvers<void>();
  const began = Promise.withResolvers<void>();
  let calls = 0;

  return Effect.gen(function* () {
    const manager = yield* VoiceCallManager;

    const elevenlabs = Effect.map(manager.providers, ({ providers }) =>
      providers.find((status) => status.provider === "elevenlabs"),
    );

    yield* manager.connect("elevenlabs", "first-key");
    const slow = yield* Effect.forkChild(Effect.result(manager.test("elevenlabs")));
    yield* Effect.promise(() => began.promise);
    yield* manager.connect("elevenlabs", "other-key");
    yield* manager.connect("elevenlabs", "first-key");
    yield* manager.test("elevenlabs");
    assert.isFalse((yield* elevenlabs)?.keyRejected);
    pending.resolve();
    yield* Fiber.join(slow);
    assert.isFalse((yield* elevenlabs)?.keyRejected);
  }).pipe(
    Effect.provide(
      makeTest({
        test: async () => {
          calls += 1;

          if (calls > 1) return;
          began.resolve();
          await pending.promise;
          throw voiceFailure("provider-auth");
        },
      }),
    ),
  );
});
