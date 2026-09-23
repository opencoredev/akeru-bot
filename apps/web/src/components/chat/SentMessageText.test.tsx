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
});
