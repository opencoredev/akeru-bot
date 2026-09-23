import { describe, expect, it } from "vite-plus/test";

import { presentThreadError } from "./threadErrorPresentation.ts";

describe("presentThreadError", () => {
  it("explains provider usage-limit failures instead of showing a generic error", () => {
    expect(presentThreadError("The usage limit has been reached")).toMatchObject({
      title: "Request limit reached",
      description: "Wait a moment, then send your message again.",
      action: "none",
    });
  });

  it("names the fix for a dropped connection instead of asking for feedback", () => {
    expect(presentThreadError("WebSocket disconnected")).toMatchObject({
      title: "Connection interrupted",
      action: "none",
    });
  });

  it("redacts local paths and bounds generic technical details", () => {
    const presentation = presentThreadError(
      `MysteryError: source file:///home/leo/private/source.ts:1:2 ${"x".repeat(800)}`,
    );

    expect(presentation.technicalDetails).toContain("file://…");
    expect(presentation.technicalDetails).not.toContain("/home/leo");
    expect(presentation.technicalDetails.length).toBeLessThanOrEqual(600);
  });

  it("points an unknown failure at feedback in plain words", () => {
    expect(presentThreadError("MysteryError: something odd")).toMatchObject({
      title: "The bot couldn’t finish that request",
      description:
        "Try sending it again. If it keeps happening, send feedback with the technical details.",
      action: "feedback",
    });
  });

  it("explains a send the server refused because the bot was archived", () => {
    expect(
      presentThreadError("Bot 'bot-1' is archived for command 'thread.turn.start'."),
    ).toMatchObject({
      title: "This bot is archived",
      description: "Restore it from the roster to chat with it again.",
      action: "none",
    });
  });
});
