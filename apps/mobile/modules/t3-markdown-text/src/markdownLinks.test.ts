import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownLinkPresentation } from "./markdownLinks";

describe("mobile Markdown Settings links", () => {
  it("preserves an Akeru Settings URL for the native press handler", () => {
    expect(resolveMarkdownLinkPresentation("grokbot://app/v1/settings?id=bot-inbox")).toEqual({
      kind: "link",
      href: "grokbot://app/v1/settings?id=bot-inbox",
    });
  });
});
