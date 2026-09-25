import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { ComputerFrame, ComputerInput, COMPUTER_FRAME_MAX_BYTES } from "./computer.ts";

describe("computer transport", () => {
  it("bounds frames and input", () => {
    const decodeFrame = Schema.decodeUnknownSync(ComputerFrame);
    expect(() =>
      decodeFrame({
        mimeType: "image/jpeg",
        width: 100,
        height: 100,
        data: "x".repeat(Math.ceil(COMPUTER_FRAME_MAX_BYTES / 3) * 4 + 1),
      }),
    ).toThrow();
    const decodeInput = Schema.decodeUnknownSync(ComputerInput);
    expect(() =>
      decodeInput({
        threadId: "thread",
        sessionId: "token",
        sequence: 0,
        action: { _tag: "key", key: "enter" },
      }),
    ).toThrow();
    expect(() =>
      decodeInput({
        threadId: "thread",
        sessionId: "token",
        sequence: 1,
        action: { _tag: "type", text: "x".repeat(4097) },
      }),
    ).toThrow();
    expect(
      decodeInput({
        threadId: "thread",
        sessionId: "token",
        sequence: 1,
        action: { _tag: "click", x: 1, y: 2, button: "left" },
      }).sequence,
    ).toBe(1);
  });
});
