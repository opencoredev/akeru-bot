import { describe, expect, it } from "vite-plus/test";

import { presentThreadError } from "./threadErrorPresentation.ts";

describe("presentThreadError", () => {
  it("explains provider usage-limit failures instead of showing a generic error", () => {
    expect(presentThreadError("The usage limit has been reached")).toMatchObject({
      title: "Provider limit reached",
      description:
        "Your provider plan hit its usage or rate limit. Wait for it to reset, then send your message again.",
      action: "none",
    });
  });

  it("gives an uncategorized failure the same copy as its category", () => {
    const context = { providerName: "Claude" };
    expect(presentThreadError("401 Unauthorized", context)).toEqual(
      presentThreadError("401 Unauthorized", { ...context, unavailability: "missing-login" }),
    );
    expect(presentThreadError("401 Unauthorized", context)).toMatchObject({
      title: "Claude is not connected",
      description: "Connect your Claude account in Settings > Providers.",
      action: "providers",
    });
    expect(presentThreadError("Too many requests", { providerName: "Grok" }).title).toBe(
      "Grok limit reached",
    );
  });

  it("names a disabled provider from the error when the chat does not know it", () => {
    expect(presentThreadError("Provider instance 'kimi' is disabled.")).toMatchObject({
      title: "Kimi For Coding is turned off",
      description: "Turn Kimi For Coding on in Settings > Providers, then send your message again.",
      action: "providers",
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

  it("uses the server's failure category when it has one", () => {
    expect(
      presentThreadError("OAuth token expired", {
        unavailability: "expired-login",
        providerName: "Claude",
      }),
    ).toMatchObject({
      title: "Claude sign-in expired",
      technicalDetails: "OAuth token expired",
      action: "providers",
    });
    expect(
      presentThreadError("WebSocket disconnected", { unavailability: "temporary-failure" }).title,
    ).toBe("Connection interrupted");
  });
});
