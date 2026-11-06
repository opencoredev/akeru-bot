import {
  DEFAULT_BOT_PERMISSION_POLICY,
  ProviderDriverKind,
  type BotPermissionPolicy,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { openCodePolicyBlock } from "./OpenCodePolicyGate.ts";

const provider = ProviderDriverKind.make("opencode");

const withDefaults = (
  defaults: Partial<BotPermissionPolicy["defaults"]>,
  toolOverrides: BotPermissionPolicy["toolOverrides"] = {},
): BotPermissionPolicy => ({
  ...DEFAULT_BOT_PERMISSION_POLICY,
  defaults: { ...DEFAULT_BOT_PERMISSION_POLICY.defaults, ...defaults },
  toolOverrides,
});

describe("openCodePolicyBlock", () => {
  it.each(["full-access", "auto-accept-edits", "auto", "approval-required"] as const)(
    "lets the default policy run in %s",
    (runtimeMode) => {
      expect(
        openCodePolicyBlock({ provider, policy: DEFAULT_BOT_PERMISSION_POLICY, runtimeMode }),
      ).toBeUndefined();
    },
  );

  it.each([
    ["write-outside deny in full access", withDefaults({ "write-outside": "deny" }), "full-access"],
    [
      "write-outside deny under approvals",
      withDefaults({ "write-outside": "deny" }),
      "approval-required",
    ],
    ["read deny", withDefaults({ read: "deny" }), "auto"],
    ["a Shell deny override", withDefaults({}, { Shell: "deny" }), "approval-required"],
    [
      "an ask full access would allow",
      withDefaults({ "environment-access": "ask" }),
      "full-access",
    ],
    [
      "an edit ask auto-accept would allow",
      withDefaults({ "write-workspace": "ask" }),
      "auto-accept-edits",
    ],
    ["an ask override in full access", withDefaults({}, { Shell: "ask" }), "full-access"],
  ] as const)("refuses %s", (_label, policy, runtimeMode) => {
    const block = openCodePolicyBlock({ provider, policy, runtimeMode });

    expect(block).toContain("can't be enforced on OpenCode");
    expect(block).toContain("Switch the bot to another provider");
  });

  // OpenCode can remember an "always" grant for a command pattern, so even a mode that
  // prompts does not give a one-use owner approval.
  it.each([
    [
      "an ask OpenCode already prompts for",
      withDefaults({ "environment-access": "ask" }),
      "approval-required",
    ],
    [
      "an edit ask in a mode that prompts for edits",
      withDefaults({ "write-workspace": "ask" }),
      "auto",
    ],
  ] as const)("refuses %s", (_label, policy, runtimeMode) => {
    expect(openCodePolicyBlock({ provider, policy, runtimeMode })).toBeDefined();
  });

  it("allows an allow override", () => {
    expect(
      openCodePolicyBlock({
        provider,
        policy: withDefaults({}, { SendToUser: "allow" }),
        runtimeMode: "full-access",
      }),
    ).toBeUndefined();
  });

  it.each(["claudeCode", "codex"])("leaves the %s driver to its own per-call checks", (driver) => {
    expect(
      openCodePolicyBlock({
        provider: ProviderDriverKind.make(driver),
        policy: withDefaults({}, { Shell: "deny" }),
        runtimeMode: "full-access",
      }),
    ).toBeUndefined();
  });
});
