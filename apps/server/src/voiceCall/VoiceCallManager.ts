// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CHATGPT_REALTIME_VOICE_MODEL,
  TrimmedNonEmptyString,
  type ChatGptRealtimeVoice,
  VoiceCallError,
  type BotId,
  type VoiceCallSnapshot,
  type VoiceCallStartInput,
  type VoiceCallStartResult,
  type VoiceSettings,
  type VoiceApiProvider,
  type VoiceTranscribeInput,
  type VoiceSynthesizeInput,
  type VoiceListVoicesResult,
  VOICE_API_PROVIDERS,
  VoiceTranscribeInput as TranscribeSchema,
  VoiceSynthesizeInput as SynthesizeSchema,
  type OrchestrationEvent,
} from "@akeru/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  classifyVoiceFailure,
  makeVoiceAdapters,
  voiceFailure,
  readVoiceResponse,
  type VoiceAdapters,
} from "./VoiceAdapters.ts";
import { ProjectionBotRepository } from "../persistence/Services/ProjectionBots.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SubscriptionAuthService } from "../subscription-auth/service.ts";

const isVoiceCallError = Schema.is(VoiceCallError);
const isTranscribeInput = Schema.is(TranscribeSchema);
const isSynthesizeInput = Schema.is(SynthesizeSchema);

const CHATGPT_REALTIME_CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls";

interface ActiveVoiceCall {
  readonly callId: string;
  readonly ownerId: string;
  readonly botId: BotId;
  readonly botName: string;
  readonly startedAt: string;
  readonly abortController: AbortController;
  readonly settings: VoiceSettings;
  readonly credentials: Partial<Record<VoiceApiProvider, string>>;
  status: "starting" | "live";
}

const CodexCliAuth = Schema.Struct({
  tokens: Schema.Struct({
    access_token: TrimmedNonEmptyString,
    account_id: TrimmedNonEmptyString,
  }),
});
const decodeCodexCliAuth = Schema.decodeUnknownSync(CodexCliAuth);

interface ChatGptRealtimeSession {
  readonly negotiate: (input: {
    readonly offerSdp: string;
    readonly instructions: string;
    readonly accessToken: string;
    readonly accountId: string;
    readonly voice: ChatGptRealtimeVoice;
    readonly signal: AbortSignal;
  }) => Promise<string>;
}

export interface VoiceCallManagerOptions {
  readonly adapters?: VoiceAdapters;
  readonly makeSession?: () => ChatGptRealtimeSession;
  readonly getCredential?: () => Promise<
    { readonly accessToken: string; readonly accountId: string } | undefined
  >;
  readonly getCodexCliCredential?: () => Promise<
    { readonly accessToken: string; readonly accountId: string } | undefined
  >;
}

export function parseCodexCliAuth(
  encoded: string,
): { readonly accessToken: string; readonly accountId: string } | undefined {
  try {
    const decoded = decodeCodexCliAuth(JSON.parse(encoded));
    return { accessToken: decoded.tokens.access_token, accountId: decoded.tokens.account_id };
  } catch {
    return undefined;
  }
}

async function getCodexCliCredential(): Promise<
  { readonly accessToken: string; readonly accountId: string } | undefined
> {
  try {
    const encoded = await NodeFSP.readFile(
      NodePath.join(NodeOS.homedir(), ".codex", "auth.json"),
      "utf8",
    );
    return parseCodexCliAuth(encoded);
  } catch {
    return undefined;
  }
}

export function defaultSession(): ChatGptRealtimeSession {
  return {
    negotiate: async ({ offerSdp, instructions, accessToken, accountId, voice, signal }) => {
      const response = await fetch(CHATGPT_REALTIME_CALL_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "ChatGPT-Account-ID": accountId,
          "Content-Type": "application/json",
          originator: "akeru",
          "User-Agent": "akeru",
        },
        body: JSON.stringify({
          sdp: offerSdp,
          session: {
            type: "realtime",
            model: CHATGPT_REALTIME_VOICE_MODEL,
            instructions,
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24_000 },
                transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: { type: "semantic_vad", interrupt_response: false },
              },
              output: { voice },
            },
            tools: [
              {
                type: "function",
                name: "send_to_chat",
                description:
                  "Send work to the bot's existing chat. Use this for requests that need files, tools, code, the workspace, permissions, or stored memory. Pass the user's request as one clear message.",
                parameters: {
                  type: "object",
                  properties: {
                    message: {
                      type: "string",
                      description: "The user's request as one clear chat message.",
                    },
                  },
                  required: ["message"],
                },
              },
            ],
            tool_choice: "auto",
          },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) {
        const detail = (await response.text()).trim().slice(0, 500);
        throw new Error(
          detail.length > 0
            ? `ChatGPT realtime call failed with status ${response.status}: ${detail}`
            : `ChatGPT realtime call failed with status ${response.status}.`,
        );
      }
      const answerSdp = new TextDecoder().decode(await readVoiceResponse(response, 65_536));
      if (answerSdp.trim().length === 0) {
        throw new Error("ChatGPT realtime call returned an empty SDP answer.");
      }
      return answerSdp;
    },
  };
}

function snapshot(active: ActiveVoiceCall | null): VoiceCallSnapshot {
  return active === null
    ? { status: "idle" }
    : {
        callId: active.callId,
        status: active.status,
        botId: active.botId,
        botName: active.botName,
        startedAt: active.startedAt,
      };
}

function instructionsForBot(bot: {
  readonly name: string;
  readonly title: string;
  readonly description: string | null;
}): string {
  return [
    `You are ${bot.name}, the user's ${bot.title}.`,
    bot.description,
    "Speak naturally. Answer first. Keep spoken replies concise.",
    "You are a bot on the user's team. Do not claim to be a person or always available.",
    `If the user asks you to stay silent while they talk to someone else, do not answer overheard speech until they address ${bot.name} or ask for a reply.`,
    "For any request that needs files, tools, code, the workspace, permissions, or stored memory, call send_to_chat with one clear request. Then tell the user that the work continues in the chat.",
    "Answer ordinary conversation directly in this live voice session.",
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n");
}

export class VoiceCallManager extends Context.Service<
  VoiceCallManager,
  {
    readonly get: Effect.Effect<VoiceCallSnapshot>;
    readonly providers: Effect.Effect<
      {
        providers: ReadonlyArray<{
          provider: VoiceApiProvider;
          connected: boolean;
          keyRejected: boolean;
        }>;
      },
      VoiceCallError
    >;
    readonly connect: (
      provider: VoiceApiProvider,
      apiKey: string,
    ) => Effect.Effect<{ provider: VoiceApiProvider; connected: boolean }, VoiceCallError>;
    readonly disconnect: (
      provider: VoiceApiProvider,
    ) => Effect.Effect<{ provider: VoiceApiProvider; connected: boolean }, VoiceCallError>;
    readonly test: (
      provider: VoiceApiProvider,
    ) => Effect.Effect<{ provider: VoiceApiProvider; connected: boolean }, VoiceCallError>;
    readonly listVoices: (
      provider: VoiceApiProvider,
      cursor?: string,
    ) => Effect.Effect<VoiceListVoicesResult, VoiceCallError>;
    readonly transcribe: (
      input: VoiceTranscribeInput,
      ownerId: string,
    ) => Effect.Effect<{ text: string }, VoiceCallError>;
    readonly synthesize: (
      input: VoiceSynthesizeInput,
      ownerId: string,
    ) => Effect.Effect<{ audioBase64: string; mimeType: "audio/mpeg" }, VoiceCallError>;
    readonly cancel: (
      operationId: string,
      ownerId: string,
    ) => Effect.Effect<{ cancelled: boolean }>;
    readonly start: (
      input: VoiceCallStartInput,
      ownerId: string,
    ) => Effect.Effect<VoiceCallStartResult, VoiceCallError>;
    readonly hangup: (
      callId: string,
      ownerId: string,
    ) => Effect.Effect<VoiceCallSnapshot, VoiceCallError>;
    readonly hangupOwner: (ownerId: string) => Effect.Effect<void>;
    /** Ends the active call when it belongs to `botId`, freeing the single call slot. */
    readonly hangupBot: (botId: BotId) => Effect.Effect<void>;
  }
>()("akeru-bot/voiceCall/VoiceCallManager") {}

const make = (options?: VoiceCallManagerOptions) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const bots = yield* ProjectionBotRepository;
    const serverSettings = yield* ServerSettingsService;
    const lock = yield* Semaphore.make(1);
    const auth = yield* SubscriptionAuthService.forSecretsDir(config.secretsDir);
    let active: ActiveVoiceCall | null = null;
    const secrets = yield* Effect.serviceOption(ServerSecretStore);
    const adapters = options?.adapters ?? makeVoiceAdapters();
    const operations = new Map<
      string,
      { ownerId: string; controller: AbortController; provider?: VoiceApiProvider }
    >();
    const operationKey = (ownerId: string, id: string) => JSON.stringify([ownerId, id]);
    const secretName = (provider: VoiceApiProvider) => `voice-${provider}`;
    const rejectedSecretName = (provider: VoiceApiProvider) => `voice-${provider}-rejected`;
    // Bumped whenever a provider's key is replaced or removed, so a Test that read
    // an earlier connection cannot record its verdict against a later one, even
    // when that later connection restored the same key.
    const generations = new Map<VoiceApiProvider, number>();
    const bumpGeneration = (provider: VoiceApiProvider) =>
      generations.set(provider, (generations.get(provider) ?? 0) + 1);
    const getKey = Effect.fn("VoiceCallManager.getKey")(function* (provider: VoiceApiProvider) {
      if (Option.isNone(secrets)) return yield* voiceFailure("provider-unavailable");
      const value = yield* secrets.value
        .get(secretName(provider))
        .pipe(Effect.mapError(() => voiceFailure("provider-unavailable")));
      if (Option.isNone(value)) return yield* voiceFailure("provider-unavailable");
      return new TextDecoder().decode(value.value);
    });
    const selectedProviders = (settings: VoiceSettings): ReadonlyArray<VoiceApiProvider> =>
      settings.provider === "chatgpt"
        ? []
        : settings.provider === "openai"
          ? ["openai"]
          : [
              ...new Set([
                settings.transcriptionProvider ?? "openai",
                settings.synthesisProvider ?? "openai",
              ]),
            ];
    const selectedVoice = (settings: VoiceSettings) => {
      const provider = settings.synthesisProvider ?? "openai";
      return settings.synthesisVoices?.[provider] ?? (provider === "openai" ? "alloy" : undefined);
    };
    const assertMutable = Effect.fn("VoiceCallManager.assertMutable")(function* (
      provider: VoiceApiProvider,
    ) {
      if (active && selectedProviders(active.settings).includes(provider))
        return yield* voiceFailure("provider-in-use");
      if (Option.isNone(secrets)) return yield* voiceFailure("provider-unavailable");
      return secrets.value;
    });
    const connect = (provider: VoiceApiProvider, apiKey: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const store = yield* assertMutable(provider);
          if (!apiKey.trim() || apiKey.length > 4096 || /[\r\n]/.test(apiKey))
            return yield* voiceFailure("invalid-input");
          const key = new TextEncoder().encode(apiKey.trim());
          yield* Effect.gen(function* () {
            const saved = yield* store.get(secretName(provider));
            yield* store.set(secretName(provider), key);
            // A replaced key drops the old rejection, so restoring that key later
            // waits for a new Test instead of reviving the stale verdict.
            if (Option.isNone(saved) || keyDigest(saved.value) !== keyDigest(key)) {
              bumpGeneration(provider);
              yield* store.remove(rejectedSecretName(provider));
            }
          }).pipe(Effect.mapError(() => voiceFailure("provider-unavailable")));
          return { provider, connected: true };
        }),
      );
    const disconnect = (provider: VoiceApiProvider) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const store = yield* assertMutable(provider);
          bumpGeneration(provider);
          for (const name of [secretName(provider), rejectedSecretName(provider)]) {
            yield* store
              .remove(name)
              .pipe(Effect.mapError(() => voiceFailure("provider-unavailable")));
          }
          // Work that already read the removed key must not finish after the disconnect.
          for (const operation of operations.values()) {
            if (operation.provider === provider) operation.controller.abort();
          }
          return { provider, connected: false };
        }),
      );
    // Digest of the saved key each provider rejected on its last Test. It lives
    // beside the key so every client, and a restarted server, sees the same
    // verdict, and a replaced key starts without one.
    const keyDigest = (key: Uint8Array | string) =>
      NodeCrypto.createHash("sha256").update(key).digest("hex");
    const providers = Effect.gen(function* () {
      const result = [];
      for (const provider of VOICE_API_PROVIDERS) {
        const read = (name: string) =>
          Option.isSome(secrets)
            ? secrets.value
                .get(name)
                .pipe(Effect.mapError(() => voiceFailure("provider-unavailable")))
            : Effect.succeed(Option.none<Uint8Array>());
        const key = yield* read(secretName(provider));
        const rejected = Option.isSome(key)
          ? yield* read(rejectedSecretName(provider))
          : Option.none<Uint8Array>();
        result.push({
          provider,
          connected: Option.isSome(key),
          keyRejected:
            Option.isSome(key) &&
            Option.isSome(rejected) &&
            new TextDecoder().decode(rejected.value) === keyDigest(key.value),
        });
      }
      return { providers: result };
    });
    // Records a Test verdict only while the tested connection is still the saved
    // one, so a slow Test of a replaced key cannot overwrite the replacement's verdict.
    const recordVerdict = (
      provider: VoiceApiProvider,
      tested: { key: string; generation: number },
      rejected: boolean,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (Option.isNone(secrets)) return;
          if ((generations.get(provider) ?? 0) !== tested.generation) return;
          const { key } = tested;
          const store = secrets.value;
          const current = yield* store.get(secretName(provider));
          if (Option.isNone(current) || keyDigest(current.value) !== keyDigest(key)) return;
          yield* rejected
            ? store.set(rejectedSecretName(provider), new TextEncoder().encode(keyDigest(key)))
            : store.remove(rejectedSecretName(provider));
        }).pipe(Effect.mapError(() => voiceFailure("provider-unavailable"))),
      );
    const test = Effect.fn("VoiceCallManager.test")(function* (provider: VoiceApiProvider) {
      const tested = yield* lock.withPermits(1)(
        Effect.map(getKey(provider), (key) => ({
          key,
          generation: generations.get(provider) ?? 0,
        })),
      );
      yield* Effect.tryPromise({
        try: (signal) => adapters.test(provider, tested.key, signal),
        catch: (cause) => classifyVoiceFailure(cause),
      }).pipe(
        Effect.tapError((error) =>
          error.reason === "provider-auth"
            ? recordVerdict(provider, tested, true).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
      yield* recordVerdict(provider, tested, false);
      return { provider, connected: true, keyRejected: false };
    });
    const listVoices = Effect.fn("VoiceCallManager.listVoices")(function* (
      provider: VoiceApiProvider,
      cursor?: string,
    ) {
      const key = yield* getKey(provider);
      return yield* Effect.tryPromise({
        try: (signal) => adapters.listVoices(provider, key, signal, cursor),
        catch: (cause) => classifyVoiceFailure(cause),
      });
    });
    const cancel = (id: string, ownerId: string) =>
      Effect.sync(() => {
        const operation = operations.get(operationKey(ownerId, id));
        operation?.controller.abort();
        return { cancelled: operation !== undefined };
      });
    const audioOperation = <A>(
      input: { operationId: string; callId?: string },
      ownerId: string,
      capability: "transcription" | "synthesis",
      run: (settings: VoiceSettings, key: string, signal: AbortSignal) => Promise<A>,
    ) =>
      Effect.gen(function* () {
        const id = operationKey(ownerId, input.operationId);
        const controller = new AbortController();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            controller.abort();
            if (operations.get(id)?.controller === controller) operations.delete(id);
          }),
        );
        const pinned = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (operations.size >= 8 || operations.has(id)) return yield* voiceFailure("busy");
            if (input.callId === undefined && active && active.ownerId !== ownerId)
              return yield* voiceFailure("call-not-active");
            if (
              input.callId !== undefined &&
              (active?.callId !== input.callId ||
                active.ownerId !== ownerId ||
                active.status !== "live" ||
                active.settings.provider !== "composed")
            )
              return yield* voiceFailure("call-not-active");
            operations.set(id, { ownerId, controller });
            const call = input.callId !== undefined ? active : null;
            const settings =
              call?.settings ??
              (yield* serverSettings.getSettings.pipe(
                Effect.map((s) => s.voice),
                Effect.mapError(() => voiceFailure()),
              ));
            if (!settings.enabled) return yield* voiceFailure("voice-disabled");
            const provider =
              capability === "transcription"
                ? (settings.transcriptionProvider ?? "openai")
                : (settings.synthesisProvider ?? "openai");
            const key = call ? call.credentials[provider] : yield* getKey(provider);
            if (!key) return yield* voiceFailure("provider-unavailable");
            if (!call) operations.set(id, { ownerId, controller, provider });
            if (controller.signal.aborted) return yield* voiceFailure("cancelled");
            return { settings, key, callSignal: call?.abortController.signal };
          }),
        );
        return yield* Effect.tryPromise({
          try: (signal) =>
            run(
              pinned.settings,
              pinned.key,
              AbortSignal.any([
                signal,
                controller.signal,
                AbortSignal.timeout(60_000),
                ...(pinned.callSignal ? [pinned.callSignal] : []),
              ]),
            ),
          catch: (cause) => (isVoiceCallError(cause) ? voiceFailure(cause.reason) : voiceFailure()),
        });
      }).pipe(Effect.scoped);
    const transcribe = (input: VoiceTranscribeInput, ownerId: string) =>
      Effect.gen(function* () {
        if (!isTranscribeInput(input)) return yield* voiceFailure("invalid-input");
        return yield* audioOperation(input, ownerId, "transcription", (settings, key, signal) =>
          adapters.transcribe(settings.transcriptionProvider ?? "openai", key, input, signal),
        );
      });
    const synthesize = (input: VoiceSynthesizeInput, ownerId: string) =>
      Effect.gen(function* () {
        if (!isSynthesizeInput(input)) return yield* voiceFailure("invalid-input");
        return yield* audioOperation(input, ownerId, "synthesis", async (settings, key, signal) => {
          const provider = settings.synthesisProvider ?? "openai";
          const voice = selectedVoice(settings);
          if (!voice) throw voiceFailure("invalid-voice");
          if (!input.callId) await adapters.validateVoice(provider, key, voice, signal);
          return adapters.synthesize(provider, key, voice, input.text, signal);
        });
      });

    const clear = (callId: string) =>
      lock.withPermits(1)(
        Effect.sync(() => {
          if (active?.callId !== callId) return;
          active.abortController.abort();
          active = null;
        }),
      );

    const start = Effect.fn("VoiceCallManager.start")(function* (
      input: VoiceCallStartInput,
      ownerId: string,
    ) {
      const voiceSettings = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.voice),
        Effect.mapError(
          () =>
            new VoiceCallError({
              reason: "voice-disabled",
              message: "Voice settings are unavailable.",
            }),
        ),
      );
      if (!voiceSettings.enabled) {
        return yield* new VoiceCallError({
          reason: "voice-disabled",
          message: "Voice calls are disabled in Settings.",
        });
      }
      if (voiceSettings.provider !== "composed" && (!input.sdp || input.sdp.length > 65_536))
        return yield* voiceFailure("invalid-input");
      const claimed = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (active !== null) {
            return yield* new VoiceCallError({
              reason: "already-active",
              message: `A call with ${active.botName} is already active. Hang up before starting another call.`,
            });
          }
          const bot = yield* bots.getById({ botId: input.botId }).pipe(
            Effect.mapError(
              () =>
                new VoiceCallError({
                  reason: "bot-not-found",
                  message: "Could not load this bot.",
                }),
            ),
          );
          if (Option.isNone(bot) || bot.value.archivedAt !== null) {
            return yield* new VoiceCallError({
              reason: "bot-not-found",
              message: "This bot is not available.",
            });
          }
          if (!bot.value.voiceEnabled) {
            return yield* new VoiceCallError({
              reason: "voice-disabled",
              message: `Voice calls are disabled for ${bot.value.name}.`,
            });
          }
          const credentials: Partial<Record<VoiceApiProvider, string>> = {};
          for (const provider of selectedProviders(voiceSettings))
            credentials[provider] = yield* getKey(provider);
          const startedAt = DateTime.formatIso(yield* DateTime.now);
          const call: ActiveVoiceCall = {
            callId: NodeCrypto.randomUUID(),
            ownerId,
            botId: bot.value.botId,
            botName: bot.value.name,
            startedAt,
            abortController: new AbortController(),
            settings: structuredClone(voiceSettings),
            credentials,
            status: "starting",
          };
          active = call;
          return { call, bot: bot.value };
        }),
      );

      return yield* Effect.gen(function* () {
        if (voiceSettings.provider !== "chatgpt") {
          return yield* Effect.gen(function* () {
            const answerSdp = yield* Effect.tryPromise({
              try: async (signal) => {
                const combined = AbortSignal.any([
                  signal,
                  claimed.call.abortController.signal,
                  AbortSignal.timeout(60_000),
                ]);
                if (voiceSettings.provider === "openai") {
                  const key = claimed.call.credentials.openai;
                  if (!key || !input.sdp) throw voiceFailure("invalid-input");
                  return adapters.negotiate(
                    key,
                    input.sdp,
                    instructionsForBot(claimed.bot),
                    voiceSettings.openaiVoice ?? "alloy",
                    combined,
                  );
                }
                const provider = voiceSettings.synthesisProvider ?? "openai";
                const key = claimed.call.credentials[provider];
                const voice = selectedVoice(voiceSettings);
                if (!key || !voice) throw voiceFailure("invalid-voice");
                await adapters.validateVoice(provider, key, voice, combined);
                return undefined;
              },
              catch: (cause) =>
                isVoiceCallError(cause) ? voiceFailure(cause.reason) : voiceFailure(),
            });
            yield* lock.withPermits(1)(
              Effect.gen(function* () {
                if (active?.callId !== claimed.call.callId)
                  return yield* voiceFailure("call-not-active");
                active.status = "live";
              }),
            );
            return {
              call: {
                callId: claimed.call.callId,
                status: "live" as const,
                botId: claimed.call.botId,
                botName: claimed.call.botName,
                startedAt: claimed.call.startedAt,
              },
              ...(answerSdp === undefined ? {} : { answerSdp }),
              transport:
                voiceSettings.provider === "composed" ? ("composed" as const) : ("webrtc" as const),
              settings: structuredClone(claimed.call.settings),
            };
          }).pipe(
            Effect.onExit((exit) =>
              exit._tag === "Success" ? Effect.void : clear(claimed.call.callId),
            ),
          );
        }

        const credential = yield* Effect.tryPromise({
          try: () =>
            options?.getCredential
              ? options.getCredential()
              : auth
                  .getOpenAICodexAccess()
                  .then(
                    (credential) =>
                      credential ?? (options?.getCodexCliCredential ?? getCodexCliCredential)(),
                  ),
          catch: () =>
            new VoiceCallError({
              reason: "subscription-unavailable",
              message: "Connect a ChatGPT subscription before starting a call.",
            }),
        }).pipe(Effect.tapError(() => clear(claimed.call.callId)));
        if (credential === undefined) {
          yield* clear(claimed.call.callId);
          return yield* new VoiceCallError({
            reason: "subscription-unavailable",
            message: "Connect a ChatGPT subscription before starting a call.",
          });
        }

        const session = yield* Effect.try({
          try: () => (options?.makeSession ?? defaultSession)(),
          catch: () => voiceFailure(),
        }).pipe(Effect.tapError(() => clear(claimed.call.callId)));
        const answerSdp = yield* Effect.tryPromise({
          try: (signal) =>
            session.negotiate({
              offerSdp: input.sdp ?? "",
              instructions: instructionsForBot(claimed.bot),
              signal: AbortSignal.any([signal, claimed.call.abortController.signal]),
              voice: voiceSettings.voice,
              ...credential,
            }),
          catch: () =>
            active?.callId === claimed.call.callId
              ? voiceFailure()
              : new VoiceCallError({
                  reason: "call-not-active",
                  message: "This call is no longer active.",
                }),
        }).pipe(Effect.tapError(() => clear(claimed.call.callId)));

        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (active?.callId !== claimed.call.callId) {
              return yield* new VoiceCallError({
                reason: "call-not-active",
                message: "This call is no longer active.",
              });
            }
            active.status = "live";
          }),
        );
        return {
          call: {
            callId: claimed.call.callId,
            status: "live" as const,
            botId: claimed.call.botId,
            botName: claimed.call.botName,
            startedAt: claimed.call.startedAt,
          },
          answerSdp,
          transport: "webrtc" as const,
          settings: structuredClone(claimed.call.settings),
        };
      }).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Success" ? Effect.void : clear(claimed.call.callId),
        ),
      );
    });

    const hangup = (callId: string, ownerId: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (active?.callId !== callId || active.ownerId !== ownerId) {
            return yield* new VoiceCallError({
              reason: "call-not-active",
              message: "This call is no longer active.",
            });
          }
          active.abortController.abort();
          active = null;
          return snapshot(active);
        }),
      );

    const hangupOwner = (ownerId: string) =>
      lock.withPermits(1)(
        Effect.sync(() => {
          for (const operation of operations.values())
            if (operation.ownerId === ownerId) operation.controller.abort();
          if (active?.ownerId !== ownerId) return;
          active.abortController.abort();
          active = null;
        }),
      );

    const hangupBot = (botId: BotId) =>
      lock.withPermits(1)(
        Effect.sync(() => {
          if (active?.botId !== botId) return;
          active.abortController.abort();
          active = null;
        }),
      );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const operation of operations.values()) operation.controller.abort();
        operations.clear();
        active?.abortController.abort();
        active = null;
      }),
    );

    return VoiceCallManager.of({
      get: Effect.sync(() => snapshot(active)),
      providers,
      connect,
      disconnect,
      test,
      listVoices,
      transcribe,
      synthesize,
      cancel,
      start,
      hangup,
      hangupOwner,
      hangupBot,
    });
  });

/** Ends a deleted bot's call as its `bot.deleted` event arrives. */
export const hangupDeletedBotCalls = <E, R>(
  voiceCalls: VoiceCallManager["Service"],
  events: Stream.Stream<OrchestrationEvent, E, R>,
) =>
  Stream.runForEach(events, (event) =>
    event.type === "bot.deleted" ? voiceCalls.hangupBot(event.payload.botId) : Effect.void,
  );

export const layer = (options?: VoiceCallManagerOptions) =>
  Layer.effect(VoiceCallManager, make(options));
