import { BotId, type VoiceSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ProjectionBotRepository,
  type ProjectionBotRepositoryShape,
} from "../persistence/Services/ProjectionBots.ts";
import { VoiceCallManager, layer } from "./VoiceCallManager.ts";
import { voiceFailure, type VoiceAdapters } from "./VoiceAdapters.ts";

const botId = BotId.make("voice-provider-bot");
const repository = {
  upsert: () => Effect.void,
  listAll: () => Effect.succeed([]),
  getById: () =>
    Effect.succeed(
      Option.some({
        botId,
        name: "Akeru",
        title: "Generalist",
        label: null,
        description: null,
        disabledMcpServerIds: [],
        avatar: { kind: "blob" as const, shape: "circle" as const, color: "#123456" },
        engine: null,
        sandbox: null,
        runtimeMode: "full-access" as const,
        usageCap: null,
        imageProvider: null,
        voiceEnabled: true,
        groupId: null,
        archivedAt: null,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }),
    ),
} satisfies ProjectionBotRepositoryShape;
const defaults: VoiceAdapters = {
  test: async () => undefined,
  listVoices: async () => ({ voices: [{ id: "alloy", name: "Alloy" }] }),
  validateVoice: async () => undefined,
  transcribe: async () => ({ text: "transcript" }),
  synthesize: async () => ({ audioBase64: "bXAz", mimeType: "audio/mpeg" }),
  negotiate: async () => "answer-sdp",
};
const makeTest = (
  adapters: Partial<VoiceAdapters> = {},
  voice: Partial<VoiceSettings> = {},
  values = new Map<string, Uint8Array>(),
) => {
  const secrets = ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  });
  return layer({ adapters: { ...defaults, ...adapters } }).pipe(
    Layer.provide(Layer.succeed(ProjectionBotRepository, repository)),
    Layer.provide(Layer.succeed(ServerSecretStore, secrets)),
    Layer.provideMerge(
      ServerSettingsService.layerTest({ voice: { provider: "composed", ...voice } }),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "voice-providers-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
};

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
      if (result._tag === "Failure") assert.equal(result.failure.reason, "provider-in-use");
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
    if (stolen._tag === "Failure") assert.equal(stolen.failure.reason, "call-not-active");
    const standalone = yield* Effect.result(
      manager.synthesize({ operationId: "standalone", text: "Hello" }, "other"),
    );
    assert.equal(standalone._tag, "Failure");
    if (standalone._tag === "Failure") assert.equal(standalone.failure.reason, "call-not-active");
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

it.effect("uses explicit transcription selection without provider fallback", () => {
  const used: string[] = [];
  return Effect.gen(function* () {
    const manager = yield* VoiceCallManager;
    yield* manager.connect("openai", "openai-key");
    const missing = yield* Effect.result(manager.start({ botId }, "owner"));
    assert.equal(missing._tag, "Failure");
    if (missing._tag === "Failure") assert.equal(missing.failure.reason, "provider-unavailable");
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
    if (result._tag === "Failure") assert.notInclude(result.failure.message, "private");
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
      if (duplicate._tag === "Failure") assert.equal(duplicate.failure.reason, "busy");
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
        if (result._tag === "Failure") assert.equal(result.failure.reason, "cancelled");
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

it.effect("replaces an idle key and reports auth and quota failures without fallback", () => {
  const used: string[] = [];
  return Effect.gen(function* () {
    const manager = yield* VoiceCallManager;
    yield* manager.connect("openai", "openai-key");
    yield* manager.connect("elevenlabs", "first-key");
    yield* manager.connect("elevenlabs", "rejected-key");
    const test = yield* Effect.result(manager.test("elevenlabs"));
    assert.equal(test._tag, "Failure");
    if (test._tag === "Failure") assert.equal(test.failure.reason, "provider-auth");
    const elevenlabs = Effect.map(manager.providers, ({ providers }) =>
      providers.find((status) => status.provider === "elevenlabs"),
    );
    // Every client reads the rejection from the server until the key changes.
    assert.isTrue((yield* elevenlabs)?.keyRejected);
    const listed = yield* Effect.result(manager.listVoices("elevenlabs"));
    assert.equal(listed._tag, "Failure");
    if (listed._tag === "Failure") assert.equal(listed.failure.reason, "provider-quota");
    const start = yield* Effect.result(manager.start({ botId }, "owner"));
    assert.equal(start._tag, "Failure");
    if (start._tag === "Failure") {
      assert.equal(start.failure.reason, "provider-auth");
      assert.notInclude(start.failure.message, "rejected-key");
    }
    assert.deepEqual(yield* manager.get, { status: "idle" });
    const standalone = yield* Effect.result(
      manager.synthesize({ operationId: "speak", text: "Hello" }, "owner"),
    );
    assert.equal(standalone._tag, "Failure");
    if (standalone._tag === "Failure") assert.equal(standalone.failure.reason, "provider-auth");
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
