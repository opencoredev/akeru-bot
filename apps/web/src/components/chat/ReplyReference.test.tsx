import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ReplyMessageBody } from "./ReplyReference";

describe("reply message", () => {
  it("shows the referenced message and the reply as separate content", () => {
    const markup = renderToStaticMarkup(
      <ReplyMessageBody text={"> Replying to Layout check\n> OK\n\nWhich message?"} />,
    );
    expect(markup).toContain('data-testid="reply-reference"');
    expect(markup).toContain("Layout check");
    expect(markup).toContain(">OK</span>");
    expect(markup).toContain(">Which message?</p>");
    expect(markup).not.toContain("&gt; Replying to");
    expect(markup).not.toContain("border-l-2");
  });
});
