import { SETTINGS_DEEP_LINK_IDS } from "@t3tools/client-runtime/settings-deep-link";
import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownLinkPresentation } from "./markdownLinks";

describe("mobile Markdown Settings links", () => {
  it.each(SETTINGS_DEEP_LINK_IDS)(
    "preserves the %s Settings URL for the native press handler",
    (id) => {
      const href = `grokbot://app/v1/settings?id=${id}`;
      expect(resolveMarkdownLinkPresentation(href)).toEqual({ kind: "link", href });
    },
  );

  it("preserves malformed in-app links so the press handler can swallow them", () => {
    for (const href of [
      "grokbot://app/v1/settings?id=unknown",
      "grokbot://app/v1/settings?id=providers&from=chat",
      "grokbot://other/v1/settings",
    ]) {
      expect(resolveMarkdownLinkPresentation(href)).toEqual({ kind: "link", href });
    }
  });
});
