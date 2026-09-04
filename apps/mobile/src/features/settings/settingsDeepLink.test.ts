import { describe, expect, it } from "vite-plus/test";

import { resolveMobileSettingsHealthTarget } from "./settingsDeepLink";

describe("mobile Settings chat links", () => {
  it.each(["local-execution", "bot-inbox", "providers"] as const)(
    "opens the %s target",
    (target) => {
      expect(resolveMobileSettingsHealthTarget(`grokbot://app/v1/settings?id=${target}`)).toBe(
        target,
      );
    },
  );

  it.each([
    "grokbot://app/v1/settings?id=providers&id=bot-inbox",
    "grokbot://app/v1/settings?id=provider-access",
    "grokbot://app/v1/settings?id=provider-access&id=bot-inbox",
    "grokbot://app/v1/settings?id=provider-access&from=chat",
    "grokbot://app/v1/settings?id=provider-access#health",
    "grokbot://other/v1/settings?id=provider-access",
  ])("rejects unsupported or malformed destination %s", (href) => {
    expect(resolveMobileSettingsHealthTarget(href)).toBeNull();
  });
});
