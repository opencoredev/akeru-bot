import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ config: {} }));

vi.mock("react-native", () => ({
  Linking: { openURL: async () => undefined },
  Pressable: ({ children }: { readonly children?: ReactNode }) =>
    createElement("button", null, children),
  View: "div",
}));

vi.mock("../../components/AppText", () => ({ AppText: "span" }));

vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: { readonly children?: ReactNode }) =>
    createElement("section", null, children),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.config }));

vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config", refreshProviders: "refresh" },
}));

vi.mock("./copySignInCode", () => ({ copySignInCode: async () => true }));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => async () => undefined }));

vi.mock("../../lib/i18n", async () => {
  const { createTranslator } = await import("@akeru/client-runtime/i18n");
  const translator = createTranslator("en");

  return { useMobileI18n: () => ({ ...translator, t: translator.translate }) };
});

import { ClaudeCodeLoginStatus } from "./ClaudeCodeLoginStatus";

const loggedOutLogin = (instanceId: string) => ({
  instanceId,
  driver: "claudeCode",
  displayName: "Claude Code work",
  enabled: true,
  installed: true,
  version: "2.1.316",
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-10-31T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

describe("ClaudeCodeLoginStatus", () => {
  it("shows each account's own login command for its config folder", () => {
    mocks.config = {
      environment: { platform: { os: "linux", arch: "x64" } },
      providers: [loggedOutLogin("claudeCode"), loggedOutLogin("claudeCode_work")],
      settings: {
        providerInstances: {
          claudeCode: { driver: "claudeCode", enabled: true },
          claudeCode_work: {
            driver: "claudeCode",
            enabled: true,
            config: { homePath: "~/.claude-work" },
          },
        },
      },
    };

    const markup = renderToStaticMarkup(<ClaudeCodeLoginStatus environmentId={"env-1" as never} />);

    expect(markup).toContain(">(unset CLAUDE_CONFIG_DIR; claude auth login)</span>");
    expect(markup).toContain(
      "CLAUDE_CONFIG_DIR=&quot;$HOME&quot;&#x27;/.claude-work&#x27; claude auth login",
    );
  });

  it("writes the command for PowerShell on a Windows environment", () => {
    mocks.config = {
      environment: { platform: { os: "windows", arch: "x64" } },
      providers: [loggedOutLogin("claudeCode_work")],
      settings: {
        providerInstances: {
          claudeCode_work: {
            driver: "claudeCode",
            enabled: true,
            config: { homePath: "D:\\Claude Work" },
          },
        },
      },
    };

    const markup = renderToStaticMarkup(<ClaudeCodeLoginStatus environmentId={"env-1" as never} />);

    expect(markup).toContain(
      "$env:CLAUDE_CONFIG_DIR = &#x27;D:\\Claude Work&#x27;; claude auth login",
    );
  });

  it("explains a hidden CLAUDE_CONFIG_DIR instead of showing the default command", () => {
    mocks.config = {
      environment: { platform: { os: "linux", arch: "x64" } },
      providers: [loggedOutLogin("claudeCode_work")],
      settings: {
        providerInstances: {
          claudeCode_work: {
            driver: "claudeCode",
            enabled: true,
            environment: [
              { name: "CLAUDE_CONFIG_DIR", value: "", sensitive: true, valueRedacted: true },
            ],
          },
        },
      },
    };

    const markup = renderToStaticMarkup(<ClaudeCodeLoginStatus environmentId={"env-1" as never} />);

    expect(markup).toContain("set CLAUDE_CONFIG_DIR to that folder, then run:");
    expect(markup).toContain(">claude auth login</span>");
    expect(markup).not.toContain("unset CLAUDE_CONFIG_DIR");
  });

  it("logs a separate account into the folder the server assigned it", () => {
    mocks.config = {
      environment: { platform: { os: "linux", arch: "x64" } },
      providers: [
        {
          ...loggedOutLogin("claudeCode_work"),
          configDirectory: "/srv/akeru/claude-code/claudeCode_work",
        },
      ],
      settings: {
        providerInstances: { claudeCode_work: { driver: "claudeCode", enabled: true } },
      },
    };

    const markup = renderToStaticMarkup(<ClaudeCodeLoginStatus environmentId={"env-1" as never} />);

    expect(markup).toContain(
      "CLAUDE_CONFIG_DIR=&#x27;/srv/akeru/claude-code/claudeCode_work&#x27; claude auth login",
    );
  });
});
