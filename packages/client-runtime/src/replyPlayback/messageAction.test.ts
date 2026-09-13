import { describe, expect, it } from "vite-plus/test";
import { replyReadoutMessageAction } from "./messageAction.ts";

describe("stored reply action eligibility", () => {
  it("offers only settled assistant text", () => {
    expect(
      replyReadoutMessageAction({ role: "user", streaming: false, text: "User prompt" }),
    ).toBeNull();
    expect(
      replyReadoutMessageAction({ role: "assistant", streaming: true, text: "Partial answer" }),
    ).toBeNull();
    expect(
      replyReadoutMessageAction({ role: "assistant", streaming: false, text: "**Stored** answer" }),
    ).toMatchObject({ text: "Stored answer", speakable: true });
  });
  it("keeps empty and code-only replies unavailable with a reason and disclosure", () => {
    expect(
      replyReadoutMessageAction({ role: "assistant", streaming: false, text: "" }),
    ).toMatchObject({ speakable: false, reason: "empty" });
    expect(
      replyReadoutMessageAction({
        role: "assistant",
        streaming: false,
        text: "```sh\nprivate-tool-output\n```",
      }),
    ).toMatchObject({ text: "", speakable: false, skipped: { codeBlocks: 1 } });
  });
  it("allows manual reading of a stored failed reply's prose", () => {
    expect(
      replyReadoutMessageAction({
        role: "assistant",
        streaming: false,
        text: "The command failed. Check the path.",
      })?.text,
    ).toBe("The command failed. Check the path.");
  });
});
