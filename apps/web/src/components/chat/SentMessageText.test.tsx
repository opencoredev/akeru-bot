import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { buildReplyPrompt } from "./MessageControls";
import { SentMessageText } from "./SentMessageText";

describe("SentMessageText", () => {
  it("keeps a one-line backlink to the quoted message and shows only the reply body", () => {
    const markup = renderToStaticMarkup(
      <SentMessageText
        text={buildReplyPrompt(
          { messageId: "message-1", label: "Akeru", text: "First line\nSecond line" },
          "Sounds right",
        )}
      />,
    );

    expect(markup).toContain('data-testid="sent-reply-backlink"');
    expect(markup).toContain("Akeru");
    expect(markup).toContain("truncate");
    expect(markup).toContain("Sounds right");
    expect(markup).not.toContain("&gt; Replying to");
  });

  it("renders an ordinary message as plain preformatted text", () => {
    const markup = renderToStaticMarkup(<SentMessageText text="> just a quote\n\nmy thoughts" />);

    expect(markup).not.toContain("sent-reply-backlink");
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain("my thoughts");
  });

  it("renders browser and chat mentions as chips", () => {
    const markup = renderToStaticMarkup(
      <SentMessageText text="check @chat:thread-9 with @browser" />,
    );

    expect(markup).toContain('data-markdown-copy="@chat:thread-9"');
    expect(markup).toContain("Unknown chat");
    expect(markup).toContain('data-markdown-copy="@browser"');
    expect(markup).toContain("Browser");
    expect(markup).toContain("check ");
  });

  it("renders an @bot:<id> mention as a chip with the bot's name", () => {
    const markup = renderToStaticMarkup(<SentMessageText text="ask @bot:bot-gone now" />);

    expect(markup).toContain('data-markdown-copy="@bot:bot-gone"');
    expect(markup).toContain("Unknown bot");
  });

  it("renders known $skill tokens as skill chips and leaves unknown ones as text", () => {
    const markup = renderToStaticMarkup(
      <SentMessageText
        text="use $review then $missing with @browser"
        skills={[{ name: "review", displayName: "Review", path: "/skills/review", enabled: true }]}
      />,
    );

    expect(markup).toContain('data-markdown-copy="$review"');
    expect(markup).toContain("Review");
    expect(markup).toContain("$missing");
    expect(markup).toContain('data-markdown-copy="@browser"');
  });
});
