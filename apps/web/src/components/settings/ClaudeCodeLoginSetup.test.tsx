import {
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@akeru/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  os: "linux" as "linux" | "windows",
  providerInstances: {} as Record<string, ProviderInstanceConfig>,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ providerInstances: mocks.providerInstances }),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ environment: { platform: { os: mocks.os, arch: "x64" } } }),
}));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => async () => undefined }));

import { ClaudeCodeLoginSetup } from "./ClaudeCodeLoginSetup";

const INSTANCE_ID = ProviderInstanceId.make("claudeCode_work");

const loggedOut = {
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("claudeCode"),
  enabled: true,
  installed: true,
  version: "2.1.316",
  status: "error" as const,
  auth: { status: "unauthenticated" as const },
  checkedAt: "2026-10-31T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const render = () =>
  renderToStaticMarkup(
    <ClaudeCodeLoginSetup
      environmentId={"env-1" as EnvironmentId}
      instanceId={INSTANCE_ID}
      provider={loggedOut}
    />,
  );

describe("ClaudeCodeLoginSetup", () => {
  it("shows the login command for the account's own config folder, quoted", () => {
    mocks.os = "linux";
    mocks.providerInstances = {
      [INSTANCE_ID]: {
        driver: ProviderDriverKind.make("claudeCode"),
        config: { homePath: "/srv/claude $(touch pwned)" },
      },
    };

    expect(render()).toContain(
      "CLAUDE_CONFIG_DIR=&#x27;/srv/claude $(touch pwned)&#x27; claude auth login",
    );
  });

  it("uses the account's CLAUDE_CONFIG_DIR variable and PowerShell on Windows", () => {
    mocks.os = "windows";
    mocks.providerInstances = {
      [INSTANCE_ID]: {
        driver: ProviderDriverKind.make("claudeCode"),
        environment: [{ name: "CLAUDE_CONFIG_DIR", value: "D:\\Claude", sensitive: false }],
      },
    };

    expect(render()).toContain(
      "$env:CLAUDE_CONFIG_DIR = &#x27;D:\\Claude&#x27;; claude auth login",
    );
  });

  it("logs a separate account into the folder the server assigned it", () => {
    mocks.os = "linux";
    mocks.providerInstances = {
      [INSTANCE_ID]: { driver: ProviderDriverKind.make("claudeCode") },
    };

    const markup = renderToStaticMarkup(
      <ClaudeCodeLoginSetup
        environmentId={"env-1" as EnvironmentId}
        instanceId={INSTANCE_ID}
        provider={{ ...loggedOut, configDirectory: "/srv/akeru/claude-code/claudeCode_work" }}
      />,
    );

    expect(markup).toContain(
      "CLAUDE_CONFIG_DIR=&#x27;/srv/akeru/claude-code/claudeCode_work&#x27; claude auth login",
    );
  });

  it("explains a hidden CLAUDE_CONFIG_DIR instead of showing the default command", () => {
    mocks.os = "linux";
    mocks.providerInstances = {
      [INSTANCE_ID]: {
        driver: ProviderDriverKind.make("claudeCode"),
        environment: [
          { name: "CLAUDE_CONFIG_DIR", value: "", sensitive: true, valueRedacted: true },
        ],
      },
    };

    const markup = render();

    expect(markup).toContain("set CLAUDE_CONFIG_DIR to that folder, then run:");
    expect(markup).toContain(">claude auth login</code>");
    expect(markup).not.toContain("unset CLAUDE_CONFIG_DIR");
  });
});
