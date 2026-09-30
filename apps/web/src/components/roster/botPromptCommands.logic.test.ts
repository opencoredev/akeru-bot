import { describe, expect, it } from "vite-plus/test";

import { applyBotPromptCommand, botPromptCommandTrigger } from "./botPromptCommands.logic";

describe("botPromptCommandTrigger", () => {
  it("opens the skill picker for a $ token anywhere in the draft", () => {
    expect(botPromptCommandTrigger("please $rev", 11)).toEqual({
      kind: "skill",
      query: "rev",
      rangeStart: 7,
      rangeEnd: 11,
    });
  });

  it("opens the command picker only for a / that starts a line", () => {
    expect(botPromptCommandTrigger("/comp", 5)?.kind).toBe("slash-command");
    expect(botPromptCommandTrigger("and/or", 6)).toBeNull();
  });

  it("stays closed for @ mentions and plain text", () => {
    expect(botPromptCommandTrigger("ask @sc", 7)).toBeNull();
    expect(botPromptCommandTrigger("hello", 5)).toBeNull();
  });
});

describe("applyBotPromptCommand", () => {
  it("replaces the typed token and parks the caret after the inserted text", () => {
    const draft = "run $rev now";
    const trigger = botPromptCommandTrigger(draft, 8)!;
    expect(applyBotPromptCommand(draft, trigger, "$review ")).toEqual({
      text: "run $review now",
      caret: 12,
    });
  });

  it("inserts a slash command at the start of the draft", () => {
    const trigger = botPromptCommandTrigger("/co", 3)!;
    expect(applyBotPromptCommand("/co", trigger, "/compact ")).toEqual({
      text: "/compact ",
      caret: 9,
    });
  });
});
