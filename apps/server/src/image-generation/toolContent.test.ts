import { describe, expect, it } from "vite-plus/test";

import { imageConsentDetail } from "./toolContent.ts";

describe("imageConsentDetail", () => {
  it("names the consented provider for an edit retry", () => {
    expect(
      imageConsentDetail({
        operation: "edit",
        prompt: "a logo",
        inputImages: ["chat-image-1"],
        allowProvider: "grok",
      }),
    ).toBe("Send the chat images to Grok?");
  });

  it("names the pinned provider when it disagrees with the consent hint", () => {
    // imageRoutePlan pins the route to `provider`; the card must name whoever
    // actually receives the images.
    expect(
      imageConsentDetail({
        operation: "edit",
        prompt: "a logo",
        inputImages: ["chat-image-1"],
        provider: "chatgpt",
        allowProvider: "grok",
      }),
    ).toBe("Send the chat images to ChatGPT?");
  });

  it("returns undefined for a request that sends no images", () => {
    expect(
      imageConsentDetail({ operation: "generate", prompt: "a logo", provider: "chatgpt" }),
    ).toBeUndefined();
  });
});
