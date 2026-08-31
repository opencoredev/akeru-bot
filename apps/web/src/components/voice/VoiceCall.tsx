import { CallEndIcon, CallIcon } from "@hugeicons/core-free-icons";
import { useAtomValue } from "@effect/atom-react";
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
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
import { resolveStickyBotEngine } from "../roster/botEngineSelection";
import { useBotThreadRuntime } from "../roster/useBotThreadRuntime";
import { useRosterStore } from "../roster/rosterStore";
import { Button } from "../ui/button";
import { AppIcon } from "../ui/app-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useProjects } from "../../state/entities";
import { useEnvironmentConnectionState, usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";

interface ActiveBrowserCall {
  readonly call: Exclude<VoiceCallSnapshot, { status: "idle" }>;
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  readonly peer: RTCPeerConnection;
  readonly microphone: MediaStream;
  readonly speaker: HTMLAudioElement;
  readonly events: RTCDataChannel;
  stopListeningForDeviceLoss: () => void;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  environmentDisconnectTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingBrowserCall {
  cancelled: boolean;
  readonly abortController: AbortController;
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  failure: Error | null;
  microphone: MediaStream | null;
  peer: RTCPeerConnection | null;
  speaker: HTMLAudioElement | null;
  events: RTCDataChannel | null;
  stopListeningForDeviceLoss: () => void;
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
  readonly speechStarted: () => void;
  readonly speechFinished: () => void;
  readonly sessionFailed: (message: string) => void;
}

function stringField(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : null;
}

export function handleVoiceChannelMessage(
  raw: string,
  handlers: VoiceCallChatHandlers,
  reply: (payload: string) => void = () => {},
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
    void handlers.appendTranscript("user", transcript);
    return;
  }
  if (
    (type === "response.output_audio_transcript.done" ||
      type === "response.audio_transcript.done") &&
    transcript.length > 0
  ) {
    void handlers.appendTranscript("assistant", transcript);
    return;
  }
  if (type === "output_audio_buffer.started") {
    handlers.speechStarted();
    return;
  }
  if (type === "output_audio_buffer.stopped") {
    handlers.speechFinished();
    return;
  }
  if (type === "response.done") {
    const response =
      typeof event === "object" && event !== null
        ? (event as Record<string, unknown>).response
        : null;
    const status = stringField(response, "status");
    if (status !== "completed" && status !== "cancelled" && status !== "incomplete") {
      handlers.sessionFailed("The voice response failed.");
    }
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
    return;
  }
  if (type === "error") {
    const realtimeError =
      typeof event === "object" && event !== null
        ? stringField((event as Record<string, unknown>).error, "message")
        : null;
    handlers.sessionFailed(realtimeError ?? "The voice session failed.");
  }
}

export function voiceStartErrorDescription(cause: unknown): string {
  if (cause instanceof DOMException) {
    switch (cause.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Allow microphone access, then try again.";
      case "NotFoundError":
        return "Connect a microphone, then try again.";
      case "NotReadableError":
      case "AbortError":
        return "The microphone is unavailable. Close other audio apps, then try again.";
    }
  }
  return cause instanceof Error ? cause.message : "Check microphone access, then try again.";
}

export function listenForMicrophoneLoss(
  microphone: Pick<MediaStream, "getAudioTracks">,
  onLost: () => void,
): () => void {
  const tracks = microphone.getAudioTracks();
  tracks.forEach((track) => track.addEventListener("ended", onLost));
  return () => tracks.forEach((track) => track.removeEventListener("ended", onLost));
}

interface VoiceCallContextValue {
  readonly activeCall: ActiveBrowserCall["call"] | null;
  readonly reconnecting: boolean;
  readonly startingBotId: string | null;
  readonly startOrReturn: (bot: Bot) => void;
  readonly hangup: () => void;
  readonly returnToCall: () => void;
}

const VoiceCallContext = createContext<VoiceCallContextValue | null>(null);

export function waitForIceGathering(
  peer: RTCPeerConnection,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
    signal?.addEventListener("abort", finish, { once: true });
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

export function voiceEnvironmentConnectionLost(
  connection: SupervisorConnectionState | null,
): boolean {
  return connection !== null && connection.phase !== "connected";
}

export function scheduleVoiceDisconnectTimeout(
  getConnectionState: () => RTCPeerConnectionState,
  onTimeout: (recovered: boolean) => void,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => onTimeout(getConnectionState() === "connected"), 5_000);
}

function stopBrowserCall(active: ActiveBrowserCall): void {
  if (active.disconnectTimer !== null) clearTimeout(active.disconnectTimer);
  if (active.environmentDisconnectTimer !== null) {
    clearTimeout(active.environmentDisconnectTimer);
  }
  active.stopListeningForDeviceLoss();
  active.events.onmessage = null;
  active.events.onerror = null;
  active.events.onclose = null;
  active.microphone.getTracks().forEach((track) => track.stop());
  active.peer.close();
  active.speaker.pause();
  active.speaker.srcObject = null;
}

function cleanPendingBrowserCall(pending: PendingBrowserCall): void {
  pending.abortController.abort();
  pending.stopListeningForDeviceLoss();
  if (pending.events) {
    pending.events.onmessage = null;
    pending.events.onerror = null;
    pending.events.onclose = null;
  }
  pending.microphone?.getTracks().forEach((track) => track.stop());
  pending.peer?.close();
  pending.speaker?.pause();
  if (pending.speaker) pending.speaker.srcObject = null;
}

export function VoiceCallProvider({ children }: { readonly children: ReactNode }) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const environmentConnection = useEnvironmentConnectionState(environmentId);
  const projects = useProjects();
  const startVoiceCall = useAtomCommand(serverEnvironment.startVoiceCall, { reportFailure: false });
  const hangupVoiceCall = useAtomCommand(serverEnvironment.hangupVoiceCall, {
    reportFailure: false,
  });
  const [activeCall, dispatchCall] = useReducer(reduceVoiceCallUiState, null);
  const [reconnecting, setReconnecting] = useState(false);
  const [startingBotId, setStartingBotId] = useState<string | null>(null);
  const sessionBotId = startingBotId ?? activeCall?.botId ?? null;
  const sessionBot = useRosterStore((state) =>
    sessionBotId === null
      ? null
      : (state.bots.find((candidate) => candidate.id === sessionBotId) ?? null),
  );
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const defaultSelection = useMemo(
    () => resolveAppModelSelectionState(settings, providers),
    [providers, settings],
  );
  const sessionModelSelection = useMemo(
    () =>
      sessionBot
        ? resolveStickyBotEngine({
            engine: sessionBot.engine,
            instanceEntries,
            settings,
            providers,
            defaultSelection,
          })
        : null,
    [defaultSelection, instanceEntries, providers, sessionBot, settings],
  );
  const runtime = useBotThreadRuntime(sessionBotId ?? "", sessionModelSelection);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const activeRef = useRef<ActiveBrowserCall | null>(null);
  const mountedRef = useRef(true);
  const pendingStartRef = useRef<PendingBrowserCall | null>(null);
  const startingBotRef = useRef<string | null>(null);
  const hangupCommandRef = useRef(hangupVoiceCall);
  hangupCommandRef.current = hangupVoiceCall;

  const endBrowserCall = useCallback(
    (
      current: ActiveBrowserCall,
      notice?: {
        readonly type: "warning" | "error";
        readonly title: string;
        readonly description?: string;
      },
    ) => {
      if (activeRef.current !== current) return;
      activeRef.current = null;
      setReconnecting(false);
      stopBrowserCall(current);
      dispatchCall({ type: "hung-up" });
      void hangupCommandRef.current({
        environmentId: current.environmentId,
        input: { callId: current.call.callId },
      });
      if (notice) toastManager.add(notice);
    },
    [],
  );

  useEffect(() => {
    const connection = environmentConnection.data;
    const pending = pendingStartRef.current;
    if (
      pending &&
      (environmentId !== pending.environmentId || voiceEnvironmentConnectionLost(connection))
    ) {
      pending.failure ??= new Error(
        environmentId !== pending.environmentId
          ? "The active environment changed."
          : "The environment connection was lost.",
      );
      cleanPendingBrowserCall(pending);
    }
    const current = activeRef.current;
    if (!current) return;
    if (environmentId !== current.environmentId) {
      endBrowserCall(current, {
        type: "warning",
        title: "Call ended",
        description: "The active environment changed.",
      });
      return;
    }
    if (!voiceEnvironmentConnectionLost(connection)) {
      if (current.environmentDisconnectTimer !== null) {
        clearTimeout(current.environmentDisconnectTimer);
        current.environmentDisconnectTimer = null;
      }
      setReconnecting(false);
      return;
    }
    setReconnecting(true);
    current.environmentDisconnectTimer ??= setTimeout(() => {
      current.environmentDisconnectTimer = null;
      endBrowserCall(current, {
        type: "warning",
        title: "Call connection lost",
        description: "Start a new call after the environment reconnects.",
      });
    }, 5_000);
  }, [endBrowserCall, environmentConnection.data, environmentId]);

  const returnToCall = useCallback(() => {
    const call = activeRef.current?.call;
    if (!call) return;
    useRosterStore.getState().selectBot(call.botId);
    void navigate({ to: "/bots/$botId", params: { botId: call.botId } });
  }, [navigate]);

  const startOrReturn = useCallback(
    (bot: Bot) => {
      const current = activeRef.current;
      if (current !== null) {
        if (current.call.botId === bot.id) returnToCall();
        else toastManager.add({ type: "warning", title: "A call is already active" });
        return;
      }
      if (startingBotRef.current !== null) return;
      if (environmentId === null) {
        toastManager.add({ type: "error", title: "Voice is unavailable" });
        return;
      }
      if (!projects.some((project) => project.environmentId === environmentId)) {
        toastManager.add({
          type: "error",
          title: "Voice is unavailable",
          description: "Add a project before you call a bot.",
        });
        return;
      }
      startingBotRef.current = bot.id;
      setStartingBotId(bot.id);
      void (async () => {
        const pending: PendingBrowserCall = {
          cancelled: false,
          abortController: new AbortController(),
          environmentId,
          failure: null,
          microphone: null,
          peer: null,
          speaker: null,
          events: null,
          stopListeningForDeviceLoss: () => {},
        };
        pendingStartRef.current = pending;
        let serverCallId: string | null = null;
        try {
          if (!navigator.mediaDevices?.getUserMedia) {
            throw new DOMException("No microphone API", "NotFoundError");
          }
          const microphone = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
          pending.microphone = microphone;
          if (pending.cancelled) {
            microphone.getTracks().forEach((track) => track.stop());
            return;
          }
          pending.stopListeningForDeviceLoss = listenForMicrophoneLoss(microphone, () => {
            pending.failure ??= new Error("The microphone disconnected.");
            pending.peer?.close();
          });
          const peer = new RTCPeerConnection();
          pending.peer = peer;
          const speaker = new Audio();
          pending.speaker = speaker;
          speaker.autoplay = true;
          peer.ontrack = (event) => {
            if (!event.streams[0]) return;
            speaker.srcObject = event.streams[0];
            void speaker.play().catch(() => undefined);
          };
          microphone.getTracks().forEach((track) => peer.addTrack(track, microphone));
          const events = peer.createDataChannel("oai-events");
          pending.events = events;
          events.onerror = () => {
            pending.failure ??= new Error("The call connection failed.");
          };
          events.onclose = () => {
            pending.failure ??= new Error("The voice session closed.");
          };
          const chatHandlers: VoiceCallChatHandlers = {
            appendTranscript: (role, text) => runtimeRef.current.appendTranscript(role, text),
            sendGoalMessage: (text) => runtimeRef.current.send(text, []),
            speechStarted: () => {
              microphone.getAudioTracks().forEach((track) => {
                track.enabled = false;
              });
            },
            speechFinished: () => {
              microphone.getAudioTracks().forEach((track) => {
                track.enabled = true;
              });
            },
            sessionFailed: (message) => {
              const active = activeRef.current;
              if (active?.events === events) {
                endBrowserCall(active, {
                  type: "error",
                  title: "Voice session failed",
                  description: message,
                });
                return;
              }
              pending.failure ??= new Error(message);
              pending.peer?.close();
            },
          };
          events.onmessage = (channelMessage) =>
            handleVoiceChannelMessage(String(channelMessage.data), chatHandlers, (payload) => {
              if (events.readyState === "open") events.send(payload);
            });
          const offer = await peer.createOffer();
          if (pending.failure) throw pending.failure;
          await peer.setLocalDescription(offer);
          if (pending.failure) throw pending.failure;
          await waitForIceGathering(peer, 5_000, pending.abortController.signal);
          if (pending.cancelled) return;
          if (pending.failure) throw pending.failure;
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
          if (pending.cancelled) {
            void hangupCommandRef.current({
              environmentId,
              input: { callId: serverCallId },
            });
            return;
          }
          if (pending.failure) throw pending.failure;
          await peer.setRemoteDescription({ type: "answer", sdp: result.value.answerSdp });
          if (pending.cancelled) {
            void hangupCommandRef.current({
              environmentId,
              input: { callId: serverCallId },
            });
            return;
          }
          if (pending.failure) throw pending.failure;
          const browserCall: ActiveBrowserCall = {
            call: result.value.call,
            environmentId,
            peer,
            microphone,
            speaker,
            events,
            stopListeningForDeviceLoss: pending.stopListeningForDeviceLoss,
            disconnectTimer: null,
            environmentDisconnectTimer: null,
          };
          activeRef.current = browserCall;
          dispatchCall({ type: "connected", call: browserCall.call });
          setReconnecting(false);
          pending.stopListeningForDeviceLoss = () => {};
          browserCall.stopListeningForDeviceLoss();
          browserCall.stopListeningForDeviceLoss = listenForMicrophoneLoss(microphone, () =>
            endBrowserCall(browserCall, {
              type: "warning",
              title: "Microphone disconnected",
              description: "Connect a microphone, then start a new call.",
            }),
          );
          events.onerror = () =>
            endBrowserCall(browserCall, {
              type: "error",
              title: "Call connection failed",
              description: "Start a new call to continue.",
            });
          events.onclose = () =>
            endBrowserCall(browserCall, {
              type: "warning",
              title: "Call ended",
              description: "The voice session closed.",
            });
          browserCall.peer.onconnectionstatechange = () => {
            const action = voiceConnectionStateAction(browserCall.peer.connectionState);
            if (action === "recovered") {
              if (browserCall.disconnectTimer !== null) {
                clearTimeout(browserCall.disconnectTimer);
                browserCall.disconnectTimer = null;
              }
              setReconnecting(false);
              return;
            }
            if (action === "wait-for-recovery") {
              setReconnecting(true);
              browserCall.disconnectTimer ??= scheduleVoiceDisconnectTimeout(
                () => browserCall.peer.connectionState,
                (recovered) => {
                  browserCall.disconnectTimer = null;
                  if (!recovered) {
                    endBrowserCall(browserCall, {
                      type: "warning",
                      title: "Call connection lost",
                      description: "Start a new call to continue.",
                    });
                  }
                },
              );
              return;
            }
            if (action === "end") {
              endBrowserCall(browserCall, {
                type: "error",
                title: "Call connection failed",
                description: "Start a new call to continue.",
              });
            }
          };
        } catch (error) {
          cleanPendingBrowserCall(pending);
          if (serverCallId !== null) {
            void hangupVoiceCall({ environmentId, input: { callId: serverCallId } });
          }
          if (pending.cancelled) return;
          toastManager.add({
            type: "error",
            title: "Could not start call",
            description: voiceStartErrorDescription(error),
          });
        } finally {
          if (pendingStartRef.current === pending) pendingStartRef.current = null;
          if (startingBotRef.current === bot.id) startingBotRef.current = null;
          if (mountedRef.current) setStartingBotId(null);
        }
      })();
    },
    [endBrowserCall, environmentId, hangupVoiceCall, projects, returnToCall, startVoiceCall],
  );

  const hangup = useCallback(() => {
    const current = activeRef.current;
    if (current) {
      endBrowserCall(current);
      return;
    }
    const pending = pendingStartRef.current;
    if (!pending) return;
    pending.cancelled = true;
    cleanPendingBrowserCall(pending);
    pendingStartRef.current = null;
    startingBotRef.current = null;
    setStartingBotId(null);
  }, [endBrowserCall]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const pending = pendingStartRef.current;
      if (pending) {
        pending.cancelled = true;
        cleanPendingBrowserCall(pending);
        pendingStartRef.current = null;
      }
      const current = activeRef.current;
      if (!current) return;
      activeRef.current = null;
      stopBrowserCall(current);
      void hangupCommandRef.current({
        environmentId: current.environmentId,
        input: { callId: current.call.callId },
      });
    };
  }, []);

  const value = useMemo<VoiceCallContextValue>(
    () => ({ activeCall, reconnecting, startingBotId, startOrReturn, hangup, returnToCall }),
    [activeCall, hangup, reconnecting, returnToCall, startOrReturn, startingBotId],
  );

  return (
    <VoiceCallContext.Provider value={value}>
      {children}
      <VoiceCallBar />
    </VoiceCallContext.Provider>
  );
}

export function useVoiceCall() {
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

export function BotVoiceCallButton({
  bot,
  disabled = false,
}: {
  readonly bot: Bot;
  readonly disabled?: boolean;
}) {
  const { activeCall, startingBotId, startOrReturn } = useVoiceCall();
  const globallyEnabled = usePrimarySettings((settings) => settings.voice.enabled);
  return (
    <BotVoiceCallButtonView
      bot={bot}
      active={activeCall?.botId === bot.id}
      disabled={disabled || startingBotId !== null}
      globallyEnabled={globallyEnabled}
      onClick={() => startOrReturn(bot)}
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
  const { activeCall, hangup, reconnecting, returnToCall, startingBotId } = useVoiceCall();
  const startingBotName = useRosterStore((state) =>
    startingBotId === null
      ? null
      : (state.bots.find((candidate) => candidate.id === startingBotId)?.name ?? "Bot"),
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activeCall) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeCall]);

  if (!activeCall) {
    return startingBotName ? (
      <VoiceCallStartingBarView botName={startingBotName} onCancel={hangup} />
    ) : null;
  }
  return (
    <VoiceCallBarView
      activeCall={activeCall}
      reconnecting={reconnecting}
      now={now}
      onReturn={returnToCall}
      onHangup={hangup}
    />
  );
}

export function VoiceCallStartingBarView({
  botName,
  onCancel,
}: {
  readonly botName: string;
  readonly onCancel: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-60 flex justify-center px-4">
      <div className="pointer-events-auto flex h-10 items-center rounded-full border border-border bg-background/95 pl-4 pr-1.5 shadow-lg backdrop-blur">
        <span className="pr-3 text-sm font-medium">Calling {botName}</span>
        <Button
          type="button"
          size="icon-sm"
          variant="destructive"
          aria-label={`Cancel call to ${botName}`}
          onClick={onCancel}
        >
          <AppIcon icon={CallEndIcon} />
        </Button>
      </div>
    </div>
  );
}

export function VoiceCallBarView({
  activeCall,
  reconnecting,
  now,
  onReturn,
  onHangup,
}: {
  readonly activeCall: ActiveBrowserCall["call"];
  readonly reconnecting: boolean;
  readonly now: number;
  readonly onReturn: () => void;
  readonly onHangup: () => void;
}) {
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
          onClick={onReturn}
        >
          <span
            className={
              reconnecting ? "size-2 rounded-full bg-warning" : "size-2 rounded-full bg-success"
            }
          />
          <span className="text-sm font-medium">{activeCall.botName}</span>
          {reconnecting ? (
            <span className="text-xs text-muted-foreground">Reconnecting</span>
          ) : null}
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
          onClick={onHangup}
        >
          <AppIcon icon={CallEndIcon} />
        </Button>
      </div>
    </div>
  );
}
