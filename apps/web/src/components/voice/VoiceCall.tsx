import { Predicate } from "effect";
import { useAtomValue } from "@effect/atom-react";
import {
  createRealtimeVoiceSession,
  createVoiceCallScope,
  runComposedVoiceCall,
  type VoiceCallChatHandlers,
  type VoiceCallScope,
} from "@akeru/client-runtime/voice";
import { BotId } from "@akeru/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import {
  useCallback,
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
import { captureVoiceUtterance, playVoiceAudio } from "./browserVoiceAudio";
import { composedVoiceAdapters } from "./composedVoiceCall";
import {
  listenForMicrophoneLoss,
  reduceVoiceCallUiState,
  resolveVoiceCallOfferSdp,
  scheduleVoiceDisconnectTimeout,
  VOICE_MODE_CHANGED_MESSAGE,
  voiceConnectionStateAction,
  voiceEnvironmentConnectionLost,
  voiceStartErrorDescription,
  waitForIceGathering,
} from "./voiceCall.logic";
import { VoiceCallBar } from "./VoiceCallControls";
import {
  type ActiveVoiceCall,
  VoiceCallContext,
  type VoiceCallContextValue,
} from "./voiceCallContext";

export { handleVoiceChannelMessage, type VoiceCallChatHandlers } from "@akeru/client-runtime/voice";

export {
  listenForMicrophoneLoss,
  reduceVoiceCallUiState,
  resolveVoiceCallOfferSdp,
  scheduleVoiceDisconnectTimeout,
  VOICE_MODE_CHANGED_MESSAGE,
  voiceConnectionStateAction,
  voiceEnvironmentConnectionLost,
  voiceStartErrorDescription,
  type VoiceCallUiAction,
  type VoiceCallUiState,
  waitForIceGathering,
} from "./voiceCall.logic";

export {
  BotVoiceCallButton,
  BotVoiceCallButtonView,
  SelectedBotVoiceCallButton,
  VoiceCallBarView,
  VoiceCallStartingBarView,
} from "./VoiceCallControls";

export { useOptionalVoiceCall, useVoiceCall } from "./voiceCallContext";

interface ActiveBrowserCall {
  readonly call: ActiveVoiceCall;
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  /** Cancels every capture, provider request, reply wait, and playback owned by this call. */
  readonly scope: VoiceCallScope;
  /** Null for composed calls, which take turns over RPC instead of WebRTC. */
  readonly peer: RTCPeerConnection | null;
  readonly microphone: MediaStream;
  readonly speaker: HTMLAudioElement;
  /** Removes this call's data channel listeners. Null for composed calls, which have no channel. */
  readonly eventListeners: AbortController | null;
  stopListeningForDeviceLoss: () => void;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  environmentDisconnectTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingBrowserCall {
  cancelled: boolean;
  readonly abortController: AbortController;
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  failure: Error | null;
  scope: VoiceCallScope | null;
  microphone: MediaStream | null;
  peer: RTCPeerConnection | null;
  speaker: HTMLAudioElement | null;
  /** Removes the data channel listeners registered while the call starts. */
  readonly eventListeners: AbortController;
  stopListeningForDeviceLoss: () => void;
}

function stopBrowserCall(active: ActiveBrowserCall): void {
  active.scope.cancel();

  if (active.disconnectTimer !== null) clearTimeout(active.disconnectTimer);

  if (active.environmentDisconnectTimer !== null) {
    clearTimeout(active.environmentDisconnectTimer);
  }

  active.stopListeningForDeviceLoss();

  active.eventListeners?.abort();

  active.microphone.getTracks().forEach((track) => track.stop());
  active.peer?.close();
  active.speaker.pause();
  active.speaker.srcObject = null;
}

function cleanPendingBrowserCall(pending: PendingBrowserCall): void {
  pending.abortController.abort();
  pending.scope?.cancel();
  pending.stopListeningForDeviceLoss();

  pending.eventListeners.abort();

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

  const transcribeVoice = useAtomCommand(serverEnvironment.transcribeVoice, {
    reportFailure: false,
  });

  const synthesizeVoice = useAtomCommand(serverEnvironment.synthesizeVoice, {
    reportFailure: false,
  });

  const cancelVoice = useAtomCommand(serverEnvironment.cancelVoice, { reportFailure: false });
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
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const voiceCommandsRef = useRef({ transcribeVoice, synthesizeVoice, cancelVoice });
  voiceCommandsRef.current = { transcribeVoice, synthesizeVoice, cancelVoice };
  // Composed calls wait for the bot's reply; these listeners re-read the turn after each render.
  const turnListenersRef = useRef(new Set<() => void>());
  useEffect(() => {
    for (const changed of turnListenersRef.current) changed();
  }, [runtime.latestTurn, runtime.messages]);
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

    // Composed calls run every turn over RPC, so they cannot ride out a disconnect.
    if (current.peer === null) {
      endBrowserCall(current, {
        type: "warning",
        title: "Call connection lost",
        description: "Start a new call after the environment reconnects.",
      });

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
          description: "Your workspace is still loading. Try again in a moment.",
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
          scope: null,
          microphone: null,
          peer: null,
          speaker: null,
          eventListeners: new AbortController(),
          stopListeningForDeviceLoss: () => {},
        };

        pendingStartRef.current = pending;
        let serverCallId: string | null = null;

        const hangupCancelledStart = (callId: string) =>
          void hangupCommandRef.current({ environmentId, input: { callId } });

        const activate = (browserCall: ActiveBrowserCall) => {
          activeRef.current = browserCall;
          dispatchCall({ type: "connected", call: browserCall.call });
          setReconnecting(false);
          pending.stopListeningForDeviceLoss = () => {};

          browserCall.stopListeningForDeviceLoss();
          browserCall.stopListeningForDeviceLoss = listenForMicrophoneLoss(
            browserCall.microphone,
            () =>
              endBrowserCall(browserCall, {
                type: "warning",
                title: "Microphone disconnected",
                description: "Connect a microphone, then start a new call.",
              }),
          );
        };

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

          const scope = createVoiceCallScope({ botId: bot.id, environmentId });
          pending.scope = scope;
          pending.stopListeningForDeviceLoss = listenForMicrophoneLoss(microphone, () => {
            pending.failure ??= new Error("The microphone disconnected.");
            pending.peer?.close();
          });
          const speaker = new Audio();
          pending.speaker = speaker;

          if (settingsRef.current.voice.provider === "composed") {
            // Capture only while listening; the loop enables tracks for each utterance.
            microphone.getAudioTracks().forEach((track) => {
              track.enabled = false;
            });

            const result = await startVoiceCall({
              environmentId,
              input: { botId: BotId.make(bot.id) },
            });

            if (Predicate.isTagged(result, "Failure")) {
              const cause = Cause.squash(result.cause);
              throw new Error(
                cause instanceof Error ? cause.message : "Could not start the voice call.",
              );
            }

            const callId = result.value.call.callId;
            serverCallId = callId;

            if (pending.cancelled) return hangupCancelledStart(callId);

            if (pending.failure) throw pending.failure;

            if (result.value.transport !== "composed") throw new Error(VOICE_MODE_CHANGED_MESSAGE);

            const browserCall: ActiveBrowserCall = {
              call: result.value.call,
              environmentId,
              scope,
              peer: null,
              microphone,
              speaker,
              eventListeners: null,
              stopListeningForDeviceLoss: pending.stopListeningForDeviceLoss,
              disconnectTimer: null,
              environmentDisconnectTimer: null,
            };

            activate(browserCall);
            const commands = () => voiceCommandsRef.current;
            void runComposedVoiceCall(
              scope,
              composedVoiceAdapters({
                callId,
                capture: (signal) => captureVoiceUtterance(microphone, signal),
                play: (audio, signal) => playVoiceAudio(speaker, audio, signal),
                transcribe: (input) => commands().transcribeVoice({ environmentId, input }),
                synthesize: (input) => commands().synthesizeVoice({ environmentId, input }),
                cancel: (operationId) =>
                  commands().cancelVoice({ environmentId, input: { operationId } }),
                sendMessage: (text) => runtimeRef.current.sendVoiceMessage(text),
                readTurn: () => ({
                  latestTurn: runtimeRef.current.latestTurn,
                  messages: runtimeRef.current.messages,
                }),
                subscribeTurn: (changed) => {
                  turnListenersRef.current.add(changed);

                  return () => turnListenersRef.current.delete(changed);
                },
              }),
            ).catch((cause: unknown) => {
              if (scope.signal.aborted) return;
              endBrowserCall(browserCall, {
                type: "error",
                title: "Voice call ended",
                description: voiceStartErrorDescription(cause),
              });
            });

            return;
          }

          const peer = new RTCPeerConnection();
          pending.peer = peer;
          speaker.autoplay = true;
          peer.ontrack = (event) => {
            if (!event.streams[0]) return;
            speaker.srcObject = event.streams[0];
            void speaker.play().catch(() => undefined);
          };

          microphone.getTracks().forEach((track) => peer.addTrack(track, microphone));
          const events = peer.createDataChannel("oai-events");
          const startListeners = { signal: pending.eventListeners.signal };
          events.addEventListener(
            "error",
            () => {
              pending.failure ??= new Error("The call connection failed.");
            },
            startListeners,
          );

          events.addEventListener(
            "close",
            () => {
              pending.failure ??= new Error("The voice session closed.");
            },
            startListeners,
          );

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

              if (active?.scope === scope) {
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

          // One session per call drops replayed event ids and duplicate send_to_chat calls.
          const session = createRealtimeVoiceSession(scope, chatHandlers, (payload) => {
            if (events.readyState === "open") events.send(payload);
          });

          const receive = (channelMessage: MessageEvent) =>
            session.receive(String(channelMessage.data));

          events.addEventListener("message", receive, startListeners);

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

          if (Predicate.isTagged(result, "Failure")) {
            const cause = Cause.squash(result.cause);
            throw new Error(
              cause instanceof Error ? cause.message : "Could not start the voice call.",
            );
          }

          serverCallId = result.value.call.callId;

          if (pending.cancelled) return hangupCancelledStart(serverCallId);

          if (pending.failure) throw pending.failure;

          if (result.value.transport !== "webrtc") throw new Error(VOICE_MODE_CHANGED_MESSAGE);

          if (!result.value.answerSdp) throw new Error("The voice call did not return an answer.");
          await peer.setRemoteDescription({ type: "answer", sdp: result.value.answerSdp });

          if (pending.cancelled) return hangupCancelledStart(serverCallId);

          if (pending.failure) throw pending.failure;

          const eventListeners = new AbortController();

          const browserCall: ActiveBrowserCall = {
            call: result.value.call,
            environmentId,
            scope,
            peer,
            microphone,
            speaker,
            eventListeners,
            stopListeningForDeviceLoss: pending.stopListeningForDeviceLoss,
            disconnectTimer: null,
            environmentDisconnectTimer: null,
          };

          activate(browserCall);
          // The call's own listeners replace the start listeners, so a channel failure ends it.
          pending.eventListeners.abort();
          const callListeners = { signal: eventListeners.signal };
          events.addEventListener("message", receive, callListeners);
          events.addEventListener(
            "error",
            () =>
              endBrowserCall(browserCall, {
                type: "error",
                title: "Call connection failed",
                description: "Start a new call to continue.",
              }),
            callListeners,
          );
          events.addEventListener(
            "close",
            () =>
              endBrowserCall(browserCall, {
                type: "warning",
                title: "Call ended",
                description: "The voice session closed.",
              }),
            callListeners,
          );
          peer.onconnectionstatechange = () => {
            const action = voiceConnectionStateAction(peer.connectionState);

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
                () => peer.connectionState,
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
