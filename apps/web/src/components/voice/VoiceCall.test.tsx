import { BotId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Bot } from "../roster/types";
import {
  BotVoiceCallButtonView,
  handleVoiceChannelMessage,
  listenForMicrophoneLoss,
  reduceVoiceCallUiState,
  resolveVoiceCallOfferSdp,
  scheduleVoiceDisconnectTimeout,
  voiceConnectionStateAction,
  voiceEnvironmentConnectionLost,
  voiceStartErrorDescription,
  waitForIceGathering,
  VoiceCallBarView,
  VoiceCallStartingBarView,
  type VoiceCallUiState,
} from "./VoiceCall";

const bot: Bot = {
  id: "bot-akeru",
  name: "Akeru",
  title: "Generalist",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
  engine: null,
  sandbox: null,
  runtimeMode: "full-access",
  usageCap: null,
  voiceEnabled: false,
  groupId: null,
  pinned: false,
  archivedAt: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

describe("voice channel messages", () => {
  const makeHandlers = () => ({
    appendTranscript: vi.fn<(role: "user" | "assistant", text: string) => void>(),
    sendGoalMessage: vi.fn<(text: string) => boolean>(() => true),
    speechStarted: vi.fn<() => void>(),
    speechFinished: vi.fn<() => void>(),
    sessionFailed: vi.fn<(message: string) => void>(),
  });

  it("writes native user and assistant transcripts to the bot thread", () => {
    const handlers = makeHandlers();
    handleVoiceChannelMessage(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "item-1",
        transcript: " Ship the fix today. ",
      }),
      handlers,
    );
    handleVoiceChannelMessage(
      JSON.stringify({
        type: "response.output_audio_transcript.done",
        transcript: "On it.",
      }),
      handlers,
    );
    expect(handlers.appendTranscript.mock.calls).toEqual([
      ["user", "Ship the fix today."],
      ["assistant", "On it."],
    ]);
    expect(handlers.sendGoalMessage).not.toHaveBeenCalled();
    expect(handlers.speechFinished).not.toHaveBeenCalled();
  });

  it("keeps the speech queue locked until WebRTC playback drains", () => {
    const handlers = makeHandlers();
    handleVoiceChannelMessage(
      JSON.stringify({
        type: "response.done",
        response: { status: "completed" },
      }),
      handlers,
    );
    expect(handlers.speechFinished).not.toHaveBeenCalled();
    handleVoiceChannelMessage(JSON.stringify({ type: "output_audio_buffer.stopped" }), handlers);
    expect(handlers.speechFinished).toHaveBeenCalledOnce();
    expect(handlers.sessionFailed).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "incomplete"])(
    "does not treat a %s response as drained playback",
    (status) => {
      const handlers = makeHandlers();
      handleVoiceChannelMessage(
        JSON.stringify({ type: "response.done", response: { status } }),
        handlers,
      );
      expect(handlers.speechFinished).not.toHaveBeenCalled();
      expect(handlers.sessionFailed).not.toHaveBeenCalled();
    },
  );

  it("ends a failed Realtime response instead of releasing the queue", () => {
    const handlers = makeHandlers();
    handleVoiceChannelMessage(
      JSON.stringify({
        type: "response.done",
        response: { status: "failed" },
      }),
      handlers,
    );
    expect(handlers.speechFinished).not.toHaveBeenCalled();
    expect(handlers.sessionFailed).toHaveBeenCalledWith("The voice response failed.");
  });

  it("reports session errors and ignores malformed channel messages", () => {
    const handlers = makeHandlers();
    handleVoiceChannelMessage("not json", handlers);
    expect(handlers.sessionFailed).not.toHaveBeenCalled();
    handleVoiceChannelMessage(
      JSON.stringify({
        type: "error",
        error: { message: "Session expired." },
      }),
      handlers,
    );
    expect(handlers.sessionFailed).toHaveBeenCalledWith("Session expired.");
  });

  it("delegates workspace work to the existing chat runtime", async () => {
    const handlers = makeHandlers();
    const replies: string[] = [];
    handleVoiceChannelMessage(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        name: "send_to_chat",
        call_id: "call-1",
        arguments: JSON.stringify({ message: "Run the focused tests" }),
      }),
      handlers,
      (payload) => replies.push(payload),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(handlers.sendGoalMessage).toHaveBeenCalledWith("Run the focused tests");
    expect(replies.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-1",
          output: JSON.stringify({ ok: true, delivered: "chat" }),
        },
      },
      { type: "response.create" },
    ]);
  });
});

describe("voice call UI", () => {
  it("hides the phone button when voice is off and shows it when voice is on", () => {
    expect(
      renderToStaticMarkup(
        <BotVoiceCallButtonView
          bot={bot}
          active={false}
          disabled={false}
          globallyEnabled
          onClick={() => {}}
        />,
      ),
    ).toBe("");

    const enabled = renderToStaticMarkup(
      <BotVoiceCallButtonView
        bot={{ ...bot, voiceEnabled: true }}
        active={false}
        disabled={false}
        globallyEnabled
        onClick={() => {}}
      />,
    );
    expect(enabled).toContain('aria-label="Call Akeru"');

    expect(
      renderToStaticMarkup(
        <BotVoiceCallButtonView
          bot={{ ...bot, voiceEnabled: true }}
          active={false}
          disabled={false}
          globallyEnabled={false}
          onClick={() => {}}
        />,
      ),
    ).toBe("");
  });

  it("uses the complete offer while ICE gathering remains in progress", () => {
    expect(
      resolveVoiceCallOfferSdp(
        { iceGatheringState: "gathering", localDescription: null },
        { type: "offer", sdp: "complete-offer" },
      ),
    ).toBe("complete-offer");
  });

  it("continues when ICE gathering does not report completion", async () => {
    vi.useFakeTimers();
    try {
      const peer = {
        iceGatheringState: "gathering",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as RTCPeerConnection;
      const gathered = waitForIceGathering(peer, 100);
      vi.advanceTimersByTime(100);
      await gathered;
      expect(peer.removeEventListener).toHaveBeenCalledWith(
        "icegatheringstatechange",
        expect.any(Function),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns microphone permission and device errors into actions", () => {
    expect(voiceStartErrorDescription(new DOMException("denied", "NotAllowedError"))).toBe(
      "Allow microphone access, then try again.",
    );
    expect(voiceStartErrorDescription(new DOMException("missing", "NotFoundError"))).toBe(
      "Connect a microphone, then try again.",
    );
  });

  it("listens for microphone loss and removes the listener during cleanup", () => {
    const track = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const onLost = vi.fn();
    const stop = listenForMicrophoneLoss(
      { getAudioTracks: () => [track as unknown as MediaStreamTrack] },
      onLost,
    );
    expect(track.addEventListener).toHaveBeenCalledWith("ended", onLost);
    stop();
    expect(track.removeEventListener).toHaveBeenCalledWith("ended", onLost);
  });

  it("keeps the recovery window until a disconnected peer reconnects", () => {
    expect(voiceConnectionStateAction("disconnected")).toBe("wait-for-recovery");
    expect(voiceConnectionStateAction("connecting")).toBe("keep-recovery-window");
    expect(voiceConnectionStateAction("new")).toBe("keep-recovery-window");
    expect(voiceConnectionStateAction("connected")).toBe("recovered");
    expect(voiceConnectionStateAction("failed")).toBe("end");
    expect(voiceConnectionStateAction("closed")).toBe("end");
  });

  it("ends a local call when its environment session disconnects", () => {
    expect(
      voiceEnvironmentConnectionLost({
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 0,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      }),
    ).toBe(false);
    expect(
      voiceEnvironmentConnectionLost({
        desired: true,
        network: "online",
        phase: "backoff",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: Date.now(),
      }),
    ).toBe(true);
  });

  it("ends the recovery window unless the peer reaches connected", () => {
    vi.useFakeTimers();
    try {
      let state: RTCPeerConnectionState = "disconnected";
      const results: boolean[] = [];
      scheduleVoiceDisconnectTimeout(
        () => state,
        (recovered) => results.push(recovered),
      );
      state = "connecting";
      vi.advanceTimersByTime(5_000);
      expect(results).toEqual([false]);

      scheduleVoiceDisconnectTimeout(
        () => state,
        (recovered) => results.push(recovered),
      );
      state = "connected";
      vi.advanceTimersByTime(5_000);
      expect(results).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the persistent call state on hangup", () => {
    const active: VoiceCallUiState = {
      callId: "call-1",
      status: "live",
      botId: BotId.make("bot-akeru"),
      botName: "Akeru",
      startedAt: "2026-08-27T00:00:00.000Z",
    };
    expect(reduceVoiceCallUiState(active, { type: "hung-up" })).toBeNull();
  });

  it("keeps return and hangup controls visible in the active-call bar", () => {
    const startedAt = "2026-08-27T00:00:00.000Z";
    const html = renderToStaticMarkup(
      <VoiceCallBarView
        activeCall={{
          callId: "call-1",
          status: "live",
          botId: BotId.make("bot-akeru"),
          botName: "Akeru",
          startedAt,
        }}
        reconnecting
        now={Date.parse(startedAt) + 65_000}
        onReturn={() => {}}
        onHangup={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Return to call with Akeru"');
    expect(html).toContain('aria-label="Hang up"');
    expect(html).toContain("Reconnecting");
    expect(html).toContain("1:05");
  });

  it("keeps a cancel control visible while a call starts", () => {
    const html = renderToStaticMarkup(
      <VoiceCallStartingBarView botName="Akeru" onCancel={() => {}} />,
    );
    expect(html).toContain("Calling Akeru");
    expect(html).toContain('aria-label="Cancel call to Akeru"');
  });
});
