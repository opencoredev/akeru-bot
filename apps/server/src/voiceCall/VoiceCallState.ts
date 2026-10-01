import {
  type BotId,
  type VoiceCallSnapshot,
  type VoiceSettings,
  type VoiceApiProvider,
} from "@akeru/contracts";

export interface ActiveVoiceCall {
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

export function snapshot(active: ActiveVoiceCall | null): VoiceCallSnapshot {
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
