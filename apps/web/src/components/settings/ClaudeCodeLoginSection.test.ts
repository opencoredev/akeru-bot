import { ProviderDriverKind } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { enabledClaudeCodeLoginInstance } from "./ClaudeCodeLoginSection";

const driver = ProviderDriverKind.make("claudeCode");

describe("enabledClaudeCodeLoginInstance", () => {
  it("adds the connection when there is none", () => {
    expect(enabledClaudeCodeLoginInstance(undefined)).toMatchObject({ driver, enabled: true });
  });

  it("turns a switched-off connection back on and keeps its account settings", () => {
    const disabled = {
      driver,
      enabled: false,
      displayName: "Work Claude",
      config: { homePath: "~/.claude-work", binaryPath: "/opt/claude" },
      environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/srv/claude", sensitive: false }],
    };

    expect(enabledClaudeCodeLoginInstance(disabled)).toEqual({ ...disabled, enabled: true });
  });

  it("leaves a connection that is already on alone", () => {
    expect(enabledClaudeCodeLoginInstance({ driver, enabled: true })).toBeUndefined();
    expect(enabledClaudeCodeLoginInstance({ driver })).toBeUndefined();
  });
});
