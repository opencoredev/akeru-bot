import { describe, expect, it } from "vite-plus/test";

import {
  isAppDeepLink,
  parseSettingsDeepLinkId,
  settingsDeepLinkHref,
} from "./settingsDeepLink.js";

describe("isAppDeepLink", () => {
  it("treats every grokbot link as in-app, including rejected ones", () => {
    expect(isAppDeepLink("grokbot://app/v1/settings?id=voice")).toBe(true);
    expect(isAppDeepLink(" GROKBOT://app/v1/settings?id=unknown")).toBe(true);
    expect(isAppDeepLink("grokbot://evil/v1/settings?id=voice")).toBe(true);
    expect(isAppDeepLink("https://example.com")).toBe(false);
    expect(isAppDeepLink("mailto:a@example.com")).toBe(false);
  });
});

describe("settingsDeepLinkHref", () => {
  it("builds a link that parses back to the same Settings section", () => {
    expect(settingsDeepLinkHref("providers")).toBe("grokbot://app/v1/settings?id=providers");
    expect(parseSettingsDeepLinkId(settingsDeepLinkHref("providers"))).toBe("providers");
  });
});

describe("parseSettingsDeepLinkId", () => {
  it("accepts the image generation section", () => {
    expect(parseSettingsDeepLinkId("grokbot://app/v1/settings?id=image-generation")).toBe(
      "image-generation",
    );
  });
});
