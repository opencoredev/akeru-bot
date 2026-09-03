import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildReplyPrompt,
  MESSAGE_REACTION_OPTIONS,
  MessageControls,
  selectedReactionForBot,
} from "./MessageControls";

const mocks = vi.hoisted(() => ({
  isCopied: false,
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: vi.fn(),
    isCopied: mocks.isCopied,
  }),
}));

describe("message controls", () => {
  it("offers the accepted compact reaction set in order", () => {
    expect(MESSAGE_REACTION_OPTIONS).toEqual(["👍", "👎", "❤️", "😂", "🎉", "😮"]);
  });

  it("resolves the current bot reaction and quotes a reply into the sent prompt", () => {
    expect(
      selectedReactionForBot(
        [
          { botId: "bot-1", emoji: "👍" },
          { botId: "bot-2", emoji: "😂" },
        ],
        "bot-2",
      ),
    ).toBe("😂");
    expect(
      buildReplyPrompt(
        { messageId: "message-1", label: "Akeru", text: "First line\nSecond line" },
        "My reply",
      ),
    ).toBe("> Replying to Akeru\n> First line\n> Second line\n\nMy reply");
  });

  it("replaces the message actions icon with a checkmark after copying", () => {
    mocks.isCopied = true;

    const html = renderToStaticMarkup(
      createElement(MessageControls, { copyText: "Copied message" }),
    );

    expect(html).toContain('aria-label="Copied"');
    expect(html).toContain("lucide-check");
    expect(html).not.toContain("Copied!");

    mocks.isCopied = false;
  });
});
