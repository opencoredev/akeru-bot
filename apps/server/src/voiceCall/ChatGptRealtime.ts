// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CHATGPT_REALTIME_VOICE_MODEL,
  TrimmedNonEmptyString,
  type ChatGptRealtimeVoice,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { readVoiceResponse } from "./VoiceAdapters.ts";

export const CHATGPT_REALTIME_CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls";

export const CodexCliAuth = Schema.Struct({
  tokens: Schema.Struct({
    access_token: TrimmedNonEmptyString,
    account_id: TrimmedNonEmptyString,
  }),
});

export const decodeCodexCliAuth = Schema.decodeUnknownSync(CodexCliAuth);

export interface ChatGptRealtimeSession {
  readonly negotiate: (input: {
    readonly offerSdp: string;
    readonly instructions: string;
    readonly accessToken: string;
    readonly accountId: string;
    readonly voice: ChatGptRealtimeVoice;
    readonly signal: AbortSignal;
  }) => Promise<string>;
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

export async function getCodexCliCredential(): Promise<
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

export function instructionsForBot(bot: {
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
