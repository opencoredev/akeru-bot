import type { VoiceCallSnapshot } from "@akeru/contracts";
import { createContext, useContext } from "react";

import type { Bot } from "../roster/types";

/** A call that has connected or is still connecting; idle snapshots never reach the UI. */
export type ActiveVoiceCall = Exclude<VoiceCallSnapshot, { status: "idle" }>;

export interface VoiceCallContextValue {
  readonly activeCall: ActiveVoiceCall | null;
  readonly reconnecting: boolean;
  readonly startingBotId: string | null;
  readonly startOrReturn: (bot: Bot) => void;
  readonly hangup: () => void;
  readonly returnToCall: () => void;
}

export const VoiceCallContext = createContext<VoiceCallContextValue | null>(null);

export function useVoiceCall() {
  const value = useContext(VoiceCallContext);
  if (!value) throw new Error("Voice call controls must be inside VoiceCallProvider.");
  return value;
}

export function useOptionalVoiceCall() {
  return useContext(VoiceCallContext);
}
