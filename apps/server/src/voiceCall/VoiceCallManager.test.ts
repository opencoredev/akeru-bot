import { BotId, VoiceCallError } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ProjectionBotRepository,
  type ProjectionBotRepositoryShape,
} from "../persistence/Services/ProjectionBots.ts";
import { defaultSession, parseCodexCliAuth, VoiceCallManager, layer } from "./VoiceCallManager.ts";

it("accepts a Codex CLI auth file without auth_mode", () => {
  assert.deepEqual(
    parseCodexCliAuth(JSON.stringify({ tokens: { access_token: "token", account_id: "account" } })),
    { accessToken: "token", accountId: "account" },
  );
  assert.isUndefined(parseCodexCliAuth("not json"));
});

it("creates a pinned realtime session through the ChatGPT subscription endpoint", async () => {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://chatgpt.com/backend-api/codex/realtime/calls");
    assert.isNull(new Headers(init?.headers).get("OpenAI-Alpha"));
    const body = JSON.parse(String(init?.body)) as {
      readonly session: {
        readonly type: string;
        readonly model: string;
        readonly audio: {
          readonly input: { readonly turn_detection: { readonly type: string } };
          readonly output: { readonly voice: string };
        };
      };
    };
    assert.equal(body.session.type, "realtime");
    assert.equal(body.session.model, "gpt-realtime-2");
    assert.equal(body.session.audio.output.voice, "marin");
    assert.equal(body.session.audio.input.turn_detection.type, "semantic_vad");
    return new Response("answer-sdp");
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const answer = await defaultSession().negotiate({
      offerSdp: "offer-sdp",
      instructions: "Be concise.",
      accessToken: "access",
      accountId: "account",
      voice: "marin",
      signal: new AbortController().signal,
    });
    assert.equal(answer, "answer-sdp");
  } finally {
    vi.unstubAllGlobals();
  }
});

const botId = BotId.make("bot-voice");
const now = "2026-08-27T00:00:00.000Z";
const bot = {
  botId,
  name: "Akeru",
  title: "Generalist",
  label: null,
  description: "Helps Leo get work done.",
  disabledMcpServerIds: [],
  avatar: { kind: "blob" as const, shape: "circle" as const, color: "#5B7FD4" },
  engine: null,
  sandbox: null,
  runtimeMode: "full-access" as const,
  usageCap: null,
  voiceEnabled: true,
  groupId: null,
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
};

const repository = {
  upsert: () => Effect.void,
  getById: ({ botId: requested }) =>
    Effect.succeed(requested === botId ? Option.some(bot) : Option.none()),
  listAll: () => Effect.succeed([bot]),
} satisfies ProjectionBotRepositoryShape;

const TestLayer = layer({
  getCredential: async () => ({ accessToken: "access", accountId: "account" }),
  makeSession: () => ({ negotiate: async () => "answer-sdp" }),
}).pipe(
  Layer.provide(Layer.succeed(ProjectionBotRepository, repository)),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "akeru-voice-call-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
);

const VoiceDisabledTestLayer = layer({
  getCredential: async () => ({ accessToken: "access", accountId: "account" }),
  makeSession: () => ({ negotiate: async () => "answer-sdp" }),
}).pipe(
  Layer.provide(Layer.succeed(ProjectionBotRepository, repository)),
  Layer.provide(ServerSettingsService.layerTest({ voice: { enabled: false } })),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "akeru-voice-call-disabled-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
);

let negotiatedVoice: string | undefined;
const SelectedVoiceTestLayer = layer({
  getCredential: async () => ({ accessToken: "access", accountId: "account" }),
  makeSession: () => ({
    negotiate: async ({ voice }) => {
      negotiatedVoice = voice;
      return "answer-sdp";
    },
  }),
}).pipe(
  Layer.provide(Layer.succeed(ProjectionBotRepository, repository)),
  Layer.provide(ServerSettingsService.layerTest({ voice: { voice: "cedar" } })),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "akeru-voice-call-selection-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
);

it.layer(SelectedVoiceTestLayer)("VoiceCallManager voice selection", (it) => {
  it.effect("uses the globally selected voice for new calls", () =>
    Effect.gen(function* () {
      negotiatedVoice = undefined;
      const manager = yield* VoiceCallManager;
      const result = yield* manager.start({ botId, sdp: "offer-sdp" }, "client-1");
      assert.equal(negotiatedVoice, "cedar");
      yield* manager.hangup(result.call.callId, "client-1");
    }),
  );
});

it.layer(VoiceDisabledTestLayer)("VoiceCallManager global settings", (it) => {
  it.effect("blocks every bot when voice is disabled globally", () =>
    Effect.gen(function* () {
      const manager = yield* VoiceCallManager;
      const result = yield* Effect.result(manager.start({ botId, sdp: "offer-sdp" }, "client-1"));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "voice-disabled");
        assert.equal(result.failure.message, "Voice calls are disabled in Settings.");
      }
    }),
  );
});

it.layer(TestLayer)("VoiceCallManager", (it) => {
  it.effect("refuses hangup from a different connection owner", () =>
    Effect.gen(function* () {
      const manager = yield* VoiceCallManager;
      const first = yield* manager.start({ botId, sdp: "offer-sdp" }, "client-1");

      const stolen = yield* Effect.result(manager.hangup(first.call.callId, "client-2"));
      assert.equal(stolen._tag, "Failure");
      if (stolen._tag === "Failure") {
        assert.equal(stolen.failure.reason, "call-not-active");
      }
      assert.equal((yield* manager.get).status, "live");

      yield* manager.hangupOwner("client-2");
      assert.equal((yield* manager.get).status, "live");

      yield* manager.hangup(first.call.callId, "client-1");
      assert.deepEqual(yield* manager.get, { status: "idle" });
    }),
  );

  it.effect("refuses a second call until hangup and clears the active call", () =>
    Effect.gen(function* () {
      const manager = yield* VoiceCallManager;
      const first = yield* manager.start({ botId, sdp: "offer-sdp" }, "client-1");
      assert.equal(first.call.status, "live");
      assert.equal(first.answerSdp, "answer-sdp");

      const second = yield* Effect.result(
        manager.start({ botId, sdp: "second-offer" }, "client-2"),
      );
      assert.equal(second._tag, "Failure");
      if (second._tag === "Failure") {
        const failure = second.failure;
        assert.instanceOf(failure, VoiceCallError);
        assert.equal(failure.reason, "already-active");
      }

      assert.deepEqual(yield* manager.hangup(first.call.callId, "client-1"), {
        status: "idle",
      });
      assert.deepEqual(yield* manager.get, { status: "idle" });

      const restarted = yield* manager.start({ botId, sdp: "third-offer" }, "client-1");
      assert.equal(restarted.call.status, "live");
      yield* manager.hangupOwner("client-1");
      assert.deepEqual(yield* manager.get, { status: "idle" });
    }),
  );
});

let codexCliCredentialRequested = false;
const CodexCliCredentialTestLayer = layer({
  getCodexCliCredential: async () => {
    codexCliCredentialRequested = true;
    return { accessToken: "codex-access", accountId: "codex-account" };
  },
  makeSession: () => ({
    negotiate: async ({ accessToken, accountId }) =>
      accessToken === "codex-access" && accountId === "codex-account"
        ? "answer-sdp"
        : Promise.reject(new Error("wrong credential")),
  }),
}).pipe(
  Layer.provide(Layer.succeed(ProjectionBotRepository, repository)),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "akeru-voice-call-codex-auth-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
);

it.layer(CodexCliCredentialTestLayer)("VoiceCallManager Codex CLI auth", (it) => {
  it.effect("uses the existing ChatGPT subscription when app auth is not connected", () =>
    Effect.gen(function* () {
      codexCliCredentialRequested = false;
      const manager = yield* VoiceCallManager;
      const result = yield* manager.start({ botId, sdp: "offer-sdp" }, "client-1");
      assert.isTrue(codexCliCredentialRequested);
      assert.equal(result.answerSdp, "answer-sdp");
    }),
  );
});

let negotiationStarted: (() => void) | undefined;
const PendingTestLayer = layer({
  getCredential: async () => ({ accessToken: "access", accountId: "account" }),
  makeSession: () => ({
    negotiate: ({ signal }) =>
      new Promise<string>((_resolve, reject) => {
        negotiationStarted?.();
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  }),
}).pipe(
  Layer.provide(Layer.succeed(ProjectionBotRepository, repository)),
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "akeru-voice-call-pending-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
);

it.layer(PendingTestLayer)("VoiceCallManager pending start", (it) => {
  it.effect("cancels an in-flight negotiation when the call hangs up", () =>
    Effect.gen(function* () {
      const manager = yield* VoiceCallManager;
      const started = new Promise<void>((resolve) => {
        negotiationStarted = resolve;
      });
      const startFiber = yield* manager
        .start({ botId, sdp: "offer-sdp" }, "client-1")
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => started);
      const pending = yield* manager.get;
      assert.notEqual(pending.status, "idle");
      if (pending.status === "idle") return;

      yield* manager.hangup(pending.callId, "client-1");
      const result = yield* Fiber.join(startFiber);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "call-not-active");
      assert.deepEqual(yield* manager.get, { status: "idle" });
    }),
  );
});
