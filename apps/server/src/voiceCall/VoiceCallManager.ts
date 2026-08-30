// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
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
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { ProjectionBotRepository } from "../persistence/Services/ProjectionBots.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SubscriptionAuthService } from "../subscription-auth/service.ts";

const CHATGPT_REALTIME_CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls";

interface ActiveVoiceCall {
  readonly callId: string;
  readonly ownerId: string;
  readonly botId: BotId;
  readonly botName: string;
  readonly startedAt: string;
  readonly abortController: AbortController;
  status: "starting" | "live";
}

const CodexCliAuth = Schema.Struct({
  tokens: Schema.Struct({
    access_token: TrimmedNonEmptyString,
    account_id: TrimmedNonEmptyString,
  }),
});

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
    const decoded = Schema.decodeUnknownSync(CodexCliAuth)(JSON.parse(encoded));
    return { accessToken: decoded.tokens.access_token, accountId: decoded.tokens.account_id };
  } catch {
    return undefined;
  }
}

async function getCodexCliCredential(): Promise<
  { readonly accessToken: string; readonly accountId: string } | undefined
> {
  try {
    const encoded = await NodeFS.readFile(
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
                  "Delegate work to the bot's existing chat thread. Use this for requests that need files, tools, code, the workspace, permissions, or stored memory. Pass the user's request as one clear message.",
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
      const answerSdp = await response.text();
      if (!response.ok) {
        const detail = answerSdp.trim().slice(0, 500);
        throw new Error(
          detail.length > 0
            ? `ChatGPT realtime call failed with status ${response.status}: ${detail}`
            : `ChatGPT realtime call failed with status ${response.status}.`,
        );
      }
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
    readonly start: (
      input: VoiceCallStartInput,
      ownerId: string,
    ) => Effect.Effect<VoiceCallStartResult, VoiceCallError>;
    readonly hangup: (
      callId: string,
      ownerId: string,
    ) => Effect.Effect<VoiceCallSnapshot, VoiceCallError>;
    readonly hangupOwner: (ownerId: string) => Effect.Effect<void>;
  }
>()("t3/voiceCall/VoiceCallManager") {}

const make = (options?: VoiceCallManagerOptions) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const bots = yield* ProjectionBotRepository;
    const serverSettings = yield* ServerSettingsService;
    const lock = yield* Semaphore.make(1);
    const auth = SubscriptionAuthService.forSecretsDir(config.secretsDir);
    let active: ActiveVoiceCall | null = null;

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
          const startedAt = DateTime.formatIso(yield* DateTime.now);
          const call: ActiveVoiceCall = {
            callId: NodeCrypto.randomUUID(),
            ownerId,
            botId: bot.value.botId,
            botName: bot.value.name,
            startedAt,
            abortController: new AbortController(),
            status: "starting",
          };
          active = call;
          return { call, bot: bot.value };
        }),
      );

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
        try: () => {
          switch (voiceSettings.provider) {
            case "chatgpt":
              return (options?.makeSession ?? defaultSession)();
          }
        },
        catch: (cause) =>
          new VoiceCallError({
            reason: "upstream-failed",
            message: cause instanceof Error ? cause.message : "Could not create the voice session.",
          }),
      }).pipe(Effect.tapError(() => clear(claimed.call.callId)));
      const answerSdp = yield* Effect.tryPromise({
        try: () =>
          session.negotiate({
            offerSdp: input.sdp,
            instructions: instructionsForBot(claimed.bot),
            signal: claimed.call.abortController.signal,
            voice: voiceSettings.voice,
            ...credential,
          }),
        catch: (cause) =>
          active?.callId === claimed.call.callId
            ? new VoiceCallError({
                reason: "upstream-failed",
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Could not start the ChatGPT realtime call.",
              })
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
      };
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
          if (active?.ownerId !== ownerId) return;
          active.abortController.abort();
          active = null;
        }),
      );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        active?.abortController.abort();
        active = null;
      }),
    );

    return VoiceCallManager.of({
      get: Effect.sync(() => snapshot(active)),
      start,
      hangup,
      hangupOwner,
    });
  });

export const layer = (options?: VoiceCallManagerOptions) =>
  Layer.effect(VoiceCallManager, make(options));
