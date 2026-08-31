import { describe, expect, it } from "vite-plus/test";

import { resolveMobileSettingsHealthTarget } from "./settingsDeepLink";

describe("mobile Settings chat links", () => {
  it.each(["local-execution", "bot-inbox"] as const)("opens the %s target", (target) => {
    expect(resolveMobileSettingsHealthTarget(`t3code://app/v1/settings?id=${target}`)).toBe(target);
  });

  it.each([
    "t3code://app/v1/settings?id=providers",
    "t3code://app/v1/settings?id=provider-access",
    "t3code://app/v1/settings?id=provider-access&id=bot-inbox",
    "t3code://app/v1/settings?id=provider-access&from=chat",
    "t3code://app/v1/settings?id=provider-access#health",
    "t3code://other/v1/settings?id=provider-access",
  ])("rejects unsupported or malformed destination %s", (href) => {
    expect(resolveMobileSettingsHealthTarget(href)).toBeNull();
  });
});
