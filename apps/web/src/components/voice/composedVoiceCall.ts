import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  correlatedVoiceReply,
  runVoiceOperation,
  waitForVoiceReply,
  type ComposedVoiceAdapters,
  type VoiceAudio,
} from "@t3tools/client-runtime/voice";
import type {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  VoiceSynthesizeInput,
  VoiceTranscribeInput,
} from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";

export interface ComposedVoiceTurnState {
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
}

/** Browser and RPC seams for one composed call. Every request is bound to `callId`. */
export interface ComposedVoiceCallDependencies {
  readonly callId: string;
  readonly capture: ComposedVoiceAdapters["capture"];
  readonly play: ComposedVoiceAdapters["play"];
  readonly transcribe: (
    input: VoiceTranscribeInput,
  ) => Promise<AtomCommandResult<{ readonly text: string }, unknown>>;
  readonly synthesize: (
    input: VoiceSynthesizeInput,
  ) => Promise<AtomCommandResult<VoiceAudio, unknown>>;
  readonly cancel: (operationId: string) => Promise<unknown>;
  /** Starts a chat turn and returns its user message id, or null when the chat refused it. */
  readonly sendMessage: (text: string) => Promise<string | null>;
  readonly readTurn: () => ComposedVoiceTurnState;
  readonly subscribeTurn: (changed: () => void) => () => void;
  readonly newOperationId?: () => string;
}

function commandValue<A>(result: AtomCommandResult<A, unknown>, fallback: string): A {
  if (result._tag === "Success") return result.value;
  const error = squashAtomCommandFailure(result);
  throw error instanceof Error ? error : new Error(fallback);
}

/** Adapts the environment's voice RPCs and the bot's chat turn to the shared composed loop. */
export function composedVoiceAdapters(deps: ComposedVoiceCallDependencies): ComposedVoiceAdapters {
  const newOperationId = deps.newOperationId ?? (() => `voice-${randomUUID()}`);
  return {
    capture: deps.capture,
    play: deps.play,
    transcribe: (audio, signal) =>
      runVoiceOperation(
        signal,
        async (operationId) =>
          commandValue(
            await deps.transcribe({
              operationId,
              callId: deps.callId,
              audioBase64: audio.audioBase64,
              mimeType: audio.mimeType,
            }),
            "Could not transcribe what you said.",
          ).text,
        deps.cancel,
        newOperationId(),
      ),
    synthesize: (text, signal) =>
      runVoiceOperation(
        signal,
        async (operationId) =>
          commandValue(
            await deps.synthesize({ operationId, callId: deps.callId, text }),
            "Could not speak the reply.",
          ),
        deps.cancel,
        newOperationId(),
      ),
    sendAndWait: async (text, signal) => {
      const messageId = await deps.sendMessage(text);
      signal.throwIfAborted();
      if (messageId === null) {
        throw new Error("The chat did not accept the message. Continue in chat.");
      }
      let observedTurnId: OrchestrationLatestTurn["turnId"] | null = null;
      return waitForVoiceReply(
        signal,
        () => {
          const turn = deps.readTurn();
          if (turn.latestTurn?.requestMessageId === messageId) {
            observedTurnId = turn.latestTurn.turnId;
          }
          return correlatedVoiceReply(messageId, turn.latestTurn, turn.messages, observedTurnId);
        },
        deps.subscribeTurn,
      );
    },
  };
}
