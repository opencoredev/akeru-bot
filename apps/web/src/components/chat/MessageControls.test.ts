import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildReplyPrompt,
  findReplySourceMessageId,
  MESSAGE_REACTION_OPTIONS,
  MessageControls,
  parseReplyPrompt,
  reactionOptionFromEmoji,
  selectedReactionForPerson,
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

  it("resolves the current person reaction and quotes a reply into the sent prompt", () => {
    expect(
      selectedReactionForPerson(
        [
          { personId: "person-1", emoji: "👍" },
          { personId: "person-2", emoji: "😂" },
        ],
        "person-2",
      ),
    ).toBe("😂");
    expect(
      buildReplyPrompt(
        { messageId: "message-1", label: "Akeru", text: "First line\nSecond line" },
        "My reply",
      ),
    ).toBe("> Replying to Akeru\n> First line\n> Second line\n\nMy reply");
  });

  it("parses back the reply shape that buildReplyPrompt serializes", () => {
    const reply = { messageId: "message-1", label: "Akeru", text: "First line\n\nThird line" };

    expect(parseReplyPrompt(buildReplyPrompt(reply, "My reply\nwith two lines"))).toEqual({
      label: "Akeru",
      quotedText: "First line\n\nThird line",
      body: "My reply\nwith two lines",
    });
    expect(parseReplyPrompt(buildReplyPrompt(reply, ""))).toEqual({
      label: "Akeru",
      quotedText: "First line\n\nThird line",
      body: "",
    });
    expect(parseReplyPrompt("> Replying to you\n> Attachment\n\n> quoted in my reply")).toEqual({
      label: "you",
      quotedText: "Attachment",
      body: "> quoted in my reply",
    });
  });

  it("leaves ordinary blockquotes and near-miss replies alone", () => {
    expect(parseReplyPrompt("what am i replying to")).toBeNull();
    expect(parseReplyPrompt("> just a quote\n\nmy thoughts")).toBeNull();
    expect(parseReplyPrompt("> Replying to \n> text\n\nbody")).toBeNull();
    expect(parseReplyPrompt("> Replying to Akeru\nno quoted lines\n\nbody")).toBeNull();
    expect(parseReplyPrompt("> Replying to Akeru\n> quoted\nbody with no blank line")).toBeNull();
    expect(parseReplyPrompt(">Replying to Akeru\n> quoted\n\nbody")).toBeNull();
    expect(parseReplyPrompt("intro\n> Replying to Akeru\n> quoted\n\nbody")).toBeNull();
  });

  it("only accepts an emoji the picker actually offers", () => {
    expect(reactionOptionFromEmoji("👍")).toBe("👍");
    expect(reactionOptionFromEmoji("🦑")).toBeNull();
  });

  it("recovers the referenced message and reply body without treating ordinary quotes as replies", () => {
    const sent = buildReplyPrompt(
      { messageId: "message-1", label: "Akeru", text: "First line\n\nThird line" },
      "My reply\nwith another line",
    );
    expect(parseReplyPrompt(sent)).toEqual({
      reference: { label: "Akeru", text: "First line\n\nThird line" },
      body: "My reply\nwith another line",
    });
    expect(parseReplyPrompt("> A regular quote\n\nMy reply")).toBeNull();
    expect(
      findReplySourceMessageId(
        [
          { id: "source", text: "First line\n\nThird line" },
          { id: "reply", text: sent },
        ],
        1,
        sent,
      ),
    ).toBe("source");
    expect(
      findReplySourceMessageId(
        [
          { id: "source", text: "First line\n\nThird line" },
          { id: "duplicate", text: "First line\n\nThird line" },
          { id: "reply", text: sent },
        ],
        2,
        sent,
      ),
    ).toBeNull();
  });

  it("replaces the copy icon with a checkmark after copying", () => {
    mocks.isCopied = true;

    const html = renderToStaticMarkup(
      createElement(MessageControls, { copyText: "Copied message" }),
    );

    expect(html).toContain('aria-label="Copied"');
    expect(html).toContain("lucide-check");
    expect(html).not.toContain("Copied!");
    expect(html).not.toContain("Read aloud");

    mocks.isCopied = false;
  });

  it("copies directly instead of opening a one-item menu", () => {
    const html = renderToStaticMarkup(createElement(MessageControls, { copyText: "Hello" }));

    expect(html).toContain('aria-label="Copy message"');
    expect(html).toContain("lucide-copy");
    expect(html).not.toContain("More message actions");
  });

  it("pulls the first control onto the text edge when flush", () => {
    const flush = renderToStaticMarkup(
      createElement(MessageControls, { copyText: "Hello", flushStart: true }),
    );
    const inset = renderToStaticMarkup(createElement(MessageControls, { copyText: "Hello" }));

    expect(flush).toContain("-ms-1.5");
    expect(inset).not.toContain("-ms-1.5");
  });
});
