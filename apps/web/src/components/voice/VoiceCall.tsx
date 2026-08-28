import { CallEndIcon, CallIcon } from "@hugeicons/core-free-icons";
import { BotId, type VoiceCallSnapshot } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { Bot } from "../roster/types";
import { useBotThreadRuntime } from "../roster/useBotThreadRuntime";
import { useRosterStore } from "../roster/rosterStore";
import { Button } from "../ui/button";
import { AppIcon } from "../ui/app-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { usePrimarySettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";

interface ActiveBrowserCall {
  readonly call: Exclude<VoiceCallSnapshot, { status: "idle" }>;
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  readonly peer: RTCPeerConnection;
  readonly microphone: MediaStream;
  readonly speaker: HTMLAudioElement;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

export type VoiceCallUiState = ActiveBrowserCall["call"] | null;
export type VoiceCallUiAction =
  | { readonly type: "connected"; readonly call: ActiveBrowserCall["call"] }
  | { readonly type: "hung-up" };

export function reduceVoiceCallUiState(
  state: VoiceCallUiState,
  action: VoiceCallUiAction,
): VoiceCallUiState {
  return action.type === "connected" ? action.call : null;
}

export interface VoiceCallChatHandlers {
  readonly appendTranscript: (role: "user" | "assistant", text: string) => void | Promise<void>;
  readonly sendGoalMessage: (text: string) => boolean | Promise<boolean>;
}

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : null;
}

export function handleVoiceChannelMessage(
  raw: string,
  handlers: VoiceCallChatHandlers,
  reply: (payload: string) => void,
): void {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  const type = stringField(event, "type");
  const transcript = stringField(event, "transcript")?.trim() ?? "";
  if (type === "conversation.item.input_audio_transcription.completed" && transcript.length > 0) {
    handlers.appendTranscript("user", transcript);
    return;
  }
  if (
    (type === "response.output_audio_transcript.done" ||
      type === "response.audio_transcript.done") &&
    transcript.length > 0
  ) {
    handlers.appendTranscript("assistant", transcript);
    return;
  }
  if (
    type === "response.function_call_arguments.done" &&
    stringField(event, "name") === "send_to_chat"
  ) {
    const callId = stringField(event, "call_id");
    const finish = (output: Record<string, unknown>) => {
      if (callId === null) return;
      reply(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(output),
          },
        }),
      );
      reply(JSON.stringify({ type: "response.create" }));
    };
    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(stringField(event, "arguments") ?? "");
    } catch {
      finish({ ok: false, error: "Could not parse the tool arguments." });
      return;
    }
    const message = stringField(parsedArguments, "message")?.trim() ?? "";
    if (message.length === 0) {
      finish({ ok: false, error: "The message was empty." });
      return;
    }
    void Promise.resolve(handlers.sendGoalMessage(message))
      .catch(() => false)
      .then((delivered) =>
        finish(
          delivered
            ? { ok: true, delivered: "chat" }
            : { ok: false, error: "The chat did not accept the message." },
        ),
      );
  }
}

interface VoiceCallContextValue {
  readonly activeCall: ActiveBrowserCall["call"] | null;
  readonly startingBotId: string | null;
  readonly startOrReturn: (bot: Bot, chatHandlers?: VoiceCallChatHandlers) => void;
  readonly hangup: () => void;
  readonly returnToCall: () => void;
}

const VoiceCallContext = createContext<VoiceCallContextValue | null>(null);

export function waitForIceGathering(peer: RTCPeerConnection, timeoutMs = 5_000): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

export function resolveVoiceCallOfferSdp(
  peer: Pick<RTCPeerConnection, "iceGatheringState" | "localDescription">,
  offer: RTCSessionDescriptionInit,
): string | undefined {
  return peer.iceGatheringState === "complete"
    ? (peer.localDescription?.sdp ?? offer.sdp)
    : offer.sdp;
}

export function voiceConnectionStateAction(
  state: RTCPeerConnectionState,
): "end" | "recovered" | "wait-for-recovery" | "keep-recovery-window" {
  if (state === "failed" || state === "closed") return "end";
  if (state === "connected") return "recovered";
  if (state === "disconnected") return "wait-for-recovery";
  return "keep-recovery-window";
}

export function scheduleVoiceDisconnectTimeout(
  getConnectionState: () => RTCPeerConnectionState,
  onTimeout: (recovered: boolean) => void,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => onTimeout(getConnectionState() === "connected"), 5_000);
}

function stopBrowserCall(active: ActiveBrowserCall): void {
  if (active.disconnectTimer !== null) clearTimeout(active.disconnectTimer);
  active.microphone.getTracks().forEach((track) => track.stop());
  active.peer.close();
  active.speaker.pause();
  active.speaker.srcObject = null;
}

export function VoiceCallProvider({ children }: { readonly children: ReactNode }) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const startVoiceCall = useAtomCommand(serverEnvironment.startVoiceCall, { reportFailure: false });
  const hangupVoiceCall = useAtomCommand(serverEnvironment.hangupVoiceCall, {
    reportFailure: false,
  });
  const [activeCall, dispatchCall] = useReducer(reduceVoiceCallUiState, null);
  const [startingBotId, setStartingBotId] = useState<string | null>(null);
  const activeRef = useRef<ActiveBrowserCall | null>(null);
  const startingBotRef = useRef<string | null>(null);
  const hangupCommandRef = useRef(hangupVoiceCall);
  hangupCommandRef.current = hangupVoiceCall;

  const returnToCall = useCallback(() => {
    const call = activeRef.current?.call;
    if (!call) return;
    useRosterStore.getState().selectBot(call.botId);
    void navigate({ to: "/bots/$botId", params: { botId: call.botId } });
  }, [navigate]);

  const startOrReturn = useCallback(
    (bot: Bot, chatHandlers?: VoiceCallChatHandlers) => {
      const current = activeRef.current;
      if (current !== null) {
        if (current.call.botId === bot.id) returnToCall();
        else toastManager.add({ type: "warning", title: "A call is already active" });
        return;
      }
      if (startingBotRef.current !== null || environmentId === null) return;
      startingBotRef.current = bot.id;
      setStartingBotId(bot.id);
      void (async () => {
        let microphone: MediaStream | null = null;
        let peer: RTCPeerConnection | null = null;
        let speaker: HTMLAudioElement | null = null;
        let serverCallId: string | null = null;
        try {
          microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
          peer = new RTCPeerConnection();
          speaker = new Audio();
          speaker.autoplay = true;
          peer.ontrack = (event) => {
            if (!event.streams[0]) return;
            speaker!.srcObject = event.streams[0];
            void speaker!.play().catch(() => undefined);
          };
          microphone.getTracks().forEach((track) => peer!.addTrack(track, microphone!));
          const events = peer.createDataChannel("oai-events");
          if (chatHandlers) {
            events.onmessage = (channelMessage) => {
              handleVoiceChannelMessage(String(channelMessage.data), chatHandlers, (payload) => {
                if (events.readyState === "open") events.send(payload);
              });
            };
          }
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          await waitForIceGathering(peer);
          const sdp = resolveVoiceCallOfferSdp(peer, offer);
          if (!sdp) throw new Error("The microphone did not produce a call offer.");
          const result = await startVoiceCall({
            environmentId,
            input: { botId: BotId.make(bot.id), sdp },
          });
          if (result._tag === "Failure") {
            const cause = Cause.squash(result.cause);
            throw new Error(
              cause instanceof Error ? cause.message : "Could not start the voice call.",
            );
          }
          serverCallId = result.value.call.callId;
          await peer.setRemoteDescription({ type: "answer", sdp: result.value.answerSdp });
          const browserCall: ActiveBrowserCall = {
            call: result.value.call,
            environmentId,
            peer,
            microphone,
            speaker,
            disconnectTimer: null,
          };
          activeRef.current = browserCall;
          dispatchCall({ type: "connected", call: browserCall.call });
          const endDisconnectedCall = () => {
            if (activeRef.current !== browserCall) return;
            activeRef.current = null;
            stopBrowserCall(browserCall);
            dispatchCall({ type: "hung-up" });
            void hangupCommandRef.current({
              environmentId: browserCall.environmentId,
              input: { callId: browserCall.call.callId },
            });
            toastManager.add({ type: "warning", title: "Call ended" });
          };
          browserCall.peer.onconnectionstatechange = () => {
            const action = voiceConnectionStateAction(browserCall.peer.connectionState);
            if (action === "recovered") {
              if (browserCall.disconnectTimer !== null) {
                clearTimeout(browserCall.disconnectTimer);
                browserCall.disconnectTimer = null;
              }
              return;
            }
            if (action === "wait-for-recovery") {
              browserCall.disconnectTimer ??= scheduleVoiceDisconnectTimeout(
                () => browserCall.peer.connectionState,
                (recovered) => {
                  browserCall.disconnectTimer = null;
                  if (!recovered) endDisconnectedCall();
                },
              );
              return;
            }
            if (action === "end") endDisconnectedCall();
          };
        } catch (error) {
          microphone?.getTracks().forEach((track) => track.stop());
          peer?.close();
          if (speaker) speaker.srcObject = null;
          if (serverCallId !== null) {
            void hangupVoiceCall({ environmentId, input: { callId: serverCallId } });
          }
          toastManager.add({
            type: "error",
            title: "Could not start call",
            description: error instanceof Error ? error.message : "Check microphone access.",
          });
        } finally {
          if (startingBotRef.current === bot.id) startingBotRef.current = null;
          setStartingBotId(null);
        }
      })();
    },
    [environmentId, hangupVoiceCall, returnToCall, startVoiceCall, startingBotId],
  );

  const hangup = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    activeRef.current = null;
    stopBrowserCall(current);
    dispatchCall({ type: "hung-up" });
    void hangupVoiceCall({
      environmentId: current.environmentId,
      input: { callId: current.call.callId },
    }).then((result) => {
      if (result._tag === "Failure") {
        toastManager.add({ type: "warning", title: "Call ended locally" });
      }
    });
  }, [hangupVoiceCall]);

  useEffect(
    () => () => {
      const current = activeRef.current;
      if (!current) return;
      activeRef.current = null;
      stopBrowserCall(current);
      void hangupCommandRef.current({
        environmentId: current.environmentId,
        input: { callId: current.call.callId },
      });
    },
    [],
  );

  const value = useMemo<VoiceCallContextValue>(
    () => ({ activeCall, startingBotId, startOrReturn, hangup, returnToCall }),
    [activeCall, hangup, returnToCall, startOrReturn, startingBotId],
  );

  return (
    <VoiceCallContext.Provider value={value}>
      {children}
      <VoiceCallBar />
    </VoiceCallContext.Provider>
  );
}

function useVoiceCall() {
  const value = useContext(VoiceCallContext);
  if (!value) throw new Error("Voice call controls must be inside VoiceCallProvider.");
  return value;
}

export function BotVoiceCallButtonView({
  bot,
  active,
  disabled,
  globallyEnabled,
  onClick,
}: {
  readonly bot: Bot;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly globallyEnabled: boolean;
  readonly onClick: () => void;
}) {
  if (!globallyEnabled || !bot.voiceEnabled) return null;
  const label = active ? `Return to call with ${bot.name}` : `Call ${bot.name}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        <AppIcon icon={CallIcon} />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function BotVoiceCallButton({ bot }: { readonly bot: Bot }) {
  const { activeCall, startingBotId, startOrReturn } = useVoiceCall();
  const globallyEnabled = usePrimarySettings((settings) => settings.voice.enabled);
  const runtime = useBotThreadRuntime(bot.id, null);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const chatHandlers = useMemo<VoiceCallChatHandlers>(
    () => ({
      appendTranscript: (role, text) => runtimeRef.current.appendTranscript(role, text),
      sendGoalMessage: (text) => runtimeRef.current.send(text, []),
    }),
    [],
  );
  return (
    <BotVoiceCallButtonView
      bot={bot}
      active={activeCall?.botId === bot.id}
      disabled={startingBotId !== null}
      globallyEnabled={globallyEnabled}
      onClick={() => startOrReturn(bot, chatHandlers)}
    />
  );
}

export function SelectedBotVoiceCallButton() {
  const bot = useRosterStore((state) =>
    state.selectedBotId === null
      ? null
      : (state.bots.find((candidate) => candidate.id === state.selectedBotId) ?? null),
  );
  return bot ? <BotVoiceCallButton bot={bot} /> : null;
}

function VoiceCallBar() {
  const { activeCall, hangup, returnToCall } = useVoiceCall();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activeCall) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeCall]);

  if (!activeCall) return null;
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(activeCall.startedAt)) / 1_000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");

  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-60 flex justify-center px-4">
      <div className="pointer-events-auto flex h-10 items-center rounded-full border border-border bg-background/95 pl-4 pr-1.5 shadow-lg backdrop-blur">
        <button
          type="button"
          aria-label={`Return to call with ${activeCall.botName}`}
          className="flex items-center gap-2 pr-3"
          onClick={returnToCall}
        >
          <span className="size-2 rounded-full bg-success" />
          <span className="text-sm font-medium">{activeCall.botName}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {minutes}:{seconds}
          </span>
        </button>
        <Button
          type="button"
          size="icon-sm"
          variant="destructive"
          aria-label="Hang up"
          className="rounded-full"
          onClick={hangup}
        >
          <AppIcon icon={CallEndIcon} />
        </Button>
      </div>
    </div>
  );
}
