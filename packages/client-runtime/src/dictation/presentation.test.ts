import { describe, expect, it } from "vite-plus/test";

import {
  DICTATION_UNAVAILABLE,
  composerActionIsDictation,
  dictationControlStatus,
  dictationUnavailableReason,
} from "./presentation.ts";

describe("dictation control presentation", () => {
  it("maps session states onto announced control states", () => {
    expect(dictationControlStatus("starting")).toBe("requesting");
    expect(dictationControlStatus("recording")).toBe("recording");
    expect(dictationControlStatus("transcribing")).toBe("transcribing");
    expect(dictationControlStatus("cancelled")).toBe("canceled");
    expect(dictationControlStatus("error")).toBe("failed");
    expect(dictationControlStatus("completed")).toBe("idle");
    expect(dictationControlStatus("idle")).toBe("idle");
  });

  it("keeps the mic in the send slot until the draft has content", () => {
    expect(composerActionIsDictation({ hasDraft: false, status: "idle" })).toBe(true);
    expect(composerActionIsDictation({ hasDraft: true, status: "idle" })).toBe(false);
    expect(composerActionIsDictation({ hasDraft: true, status: "recording" })).toBe(true);
    expect(composerActionIsDictation({ hasDraft: true, status: "transcribing" })).toBe(true);
    expect(composerActionIsDictation({ hasDraft: true, status: "failed" })).toBe(true);
    expect(composerActionIsDictation({ hasDraft: true, status: "canceled" })).toBe(false);
  });

  it("prefers the most actionable current block", () => {
    expect(
      dictationUnavailableReason({
        callActive: true,
        connected: false,
        captureAvailable: false,
        transcriptionAvailable: false,
      }),
    ).toBe(DICTATION_UNAVAILABLE.callActive);
    expect(
      dictationUnavailableReason({
        callActive: false,
        connected: false,
        captureAvailable: true,
        transcriptionAvailable: true,
      }),
    ).toBe(DICTATION_UNAVAILABLE.disconnected);
    expect(
      dictationUnavailableReason({
        callActive: false,
        connected: true,
        captureAvailable: false,
        transcriptionAvailable: true,
      }),
    ).toBe(DICTATION_UNAVAILABLE.capture);
    expect(
      dictationUnavailableReason({
        callActive: false,
        connected: true,
        captureAvailable: true,
        transcriptionAvailable: false,
      }),
    ).toBe(DICTATION_UNAVAILABLE.transcription);
    expect(
      dictationUnavailableReason({
        callActive: false,
        connected: true,
        captureAvailable: true,
        transcriptionAvailable: false,
        transcriptionReason: "Voice is turned off.",
      }),
    ).toBe("Voice is turned off.");
    expect(
      dictationUnavailableReason({
        callActive: false,
        connected: true,
        captureAvailable: true,
        transcriptionAvailable: true,
      }),
    ).toBeNull();
  });
});
