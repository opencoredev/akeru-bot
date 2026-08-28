import { BotId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Bot } from "../roster/types";
import {
  BotVoiceCallButtonView,
  handleVoiceChannelMessage,
  reduceVoiceCallUiState,
  resolveVoiceCallOfferSdp,
  scheduleVoiceDisconnectTimeout,
  voiceConnectionStateAction,
  waitForIceGathering,
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
  const makeHandlers = (delivered = true) => ({
    appendTranscript: vi.fn<(role: "user" | "assistant", text: string) => void>(),
    sendGoalMessage: vi.fn<(text: string) => Promise<boolean>>(async () => delivered),
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("appends both sides of the conversation to the chat", () => {
    const handlers = makeHandlers();
    const reply = vi.fn<(payload: string) => void>();
    handleVoiceChannelMessage(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: " Ship the fix today. ",
      }),
      handlers,
      reply,
    );
    handleVoiceChannelMessage(
      JSON.stringify({
        type: "response.output_audio_transcript.done",
        transcript: "On it.",
      }),
      handlers,
      reply,
    );
    expect(handlers.appendTranscript.mock.calls).toEqual([
      ["user", "Ship the fix today."],
      ["assistant", "On it."],
    ]);
    expect(handlers.sendGoalMessage).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("forwards a send_to_chat call as a goal message and confirms to the model", async () => {
    const handlers = makeHandlers();
    const reply = vi.fn<(payload: string) => void>();
    handleVoiceChannelMessage(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        name: "send_to_chat",
        call_id: "call-abc",
        arguments: JSON.stringify({ message: "Add retries to the sync job." }),
      }),
      handlers,
      reply,
    );
    await flush();
    expect(handlers.sendGoalMessage).toHaveBeenCalledWith("Add retries to the sync job.");
    expect(handlers.appendTranscript).not.toHaveBeenCalled();
    const output = JSON.parse(reply.mock.calls[0]![0]) as { item: { output: string } };
    const respond = JSON.parse(reply.mock.calls[1]![0]) as unknown;
    expect(output).toMatchObject({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call-abc" },
    });
    expect(JSON.parse(output.item.output)).toEqual({ ok: true, delivered: "chat" });
    expect(respond).toMatchObject({ type: "response.create" });
  });

  it("reports a failed delivery to the model instead of claiming success", async () => {
    const handlers = makeHandlers(false);
    const reply = vi.fn<(payload: string) => void>();
    handleVoiceChannelMessage(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        name: "send_to_chat",
        call_id: "call-def",
        arguments: JSON.stringify({ message: "Fix the flaky test." }),
      }),
      handlers,
      reply,
    );
    await flush();
    const output = JSON.parse(reply.mock.calls[0]![0]) as { item: { output: string } };
    expect(JSON.parse(output.item.output)).toMatchObject({ ok: false });
  });

  it("acknowledges malformed tool arguments instead of hanging the call", async () => {
    const handlers = makeHandlers();
    const reply = vi.fn<(payload: string) => void>();
    handleVoiceChannelMessage("not json", handlers, reply);
    expect(reply).not.toHaveBeenCalled();
    handleVoiceChannelMessage(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        name: "send_to_chat",
        call_id: "call-broken",
        arguments: "broken",
      }),
      handlers,
      reply,
    );
    await flush();
    expect(handlers.sendGoalMessage).not.toHaveBeenCalled();
    const output = JSON.parse(reply.mock.calls[0]![0]) as { item: { output: string } };
    expect(JSON.parse(output.item.output)).toMatchObject({ ok: false });
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

  it("keeps the recovery window until a disconnected peer reconnects", () => {
    expect(voiceConnectionStateAction("disconnected")).toBe("wait-for-recovery");
    expect(voiceConnectionStateAction("connecting")).toBe("keep-recovery-window");
    expect(voiceConnectionStateAction("new")).toBe("keep-recovery-window");
    expect(voiceConnectionStateAction("connected")).toBe("recovered");
    expect(voiceConnectionStateAction("failed")).toBe("end");
    expect(voiceConnectionStateAction("closed")).toBe("end");
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
});
