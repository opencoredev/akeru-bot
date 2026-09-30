import { BotId, EnvironmentId, MessageId, ProjectId } from "@t3tools/contracts";
import type { ChannelBinding } from "@t3tools/contracts";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  snapshot: undefined as unknown,
  session: undefined as unknown,
  pressables: [] as Array<{ onPress: () => void; disabled?: boolean }>,
  changeProject: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "session-state" ? state.session : state.snapshot),
}));
vi.mock("../../state/shell", () => ({ environmentSnapshotAtom: (id: string) => id }));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => "session-state" },
}));
vi.mock("../../state/bots", () => ({
  botEnvironment: { channels: { changeProject: "change-project" } },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "change-project" ? state.changeProject : null),
}));
vi.mock("../../lib/i18n", async () => {
  const { createTranslator } = await import("@t3tools/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useMobileI18n: () => ({ ...translator, t: translator.translate }) };
});
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    Text: "span",
    View: "div",
    Alert: { alert: state.alert },
    Pressable: (props: { onPress: () => void; disabled?: boolean; children: ReactNode }) => {
      state.pressables.push(props);
      return createElement("button", null, props.children);
    },
  };
});

import { ThreadChannels } from "./ThreadChannels";

const botId = BotId.make("bot-1");
const projectId = ProjectId.make("project-1");
const environmentId = EnvironmentId.make("environment-1");
const binding: ChannelBinding = {
  botId,
  projectId,
  provider: "telegram",
  status: "connected",
  externalIdentity: "private-identity",
  connectedAt: null,
  sentMessageIds: [MessageId.make("message-1")],
};

function render(bot = botId) {
  return renderToStaticMarkup(createElement(ThreadChannels, { environmentId, botId: bot }));
}

describe("mobile thread channels", () => {
  beforeEach(() => {
    state.pressables = [];
    state.changeProject.mockReset().mockResolvedValue({ _tag: "Success" });
    state.alert.mockReset();
    state.session = { _tag: "Success", value: { authenticated: true, scopes: ["access:write"] } };
    state.snapshot = {
      bots: [{ id: botId, channelBindings: [binding] }],
      projects: [{ id: projectId, title: "Selected workspace" }],
    };
  });

  it("renders health, selected project, and confirmed delivery without repair actions", () => {
    const html = render();
    expect(html).toContain("Telegram");
    expect(html).toContain("Connected");
    expect(html).toContain("Selected workspace");
    expect(html).toContain("1 confirmed delivery");
    expect(html).not.toContain("private-");
    expect(html).not.toContain("button");
    expect(html).not.toContain("input");
  });

  it("explains a categorized failure in plain words", () => {
    state.snapshot = {
      bots: [
        {
          id: botId,
          channelBindings: [
            {
              ...binding,
              status: "failed",
              failureCategory: "credentials",
              lastError: "private-credential-error",
            },
          ],
        },
      ],
      projects: [{ id: projectId, title: "Selected workspace" }],
    };
    const html = render();
    expect(html).toContain("Telegram rejected the bot token.");
    expect(html).not.toContain("Channel needs attention");
    expect(html).not.toContain("private-credential-error");
  });

  it("shows the saved reason when a channel has no failure category", () => {
    state.snapshot = {
      bots: [
        {
          id: botId,
          channelBindings: [
            {
              ...binding,
              status: "not-live",
              failureCategory: undefined,
              lastError: "WhatsApp needs a public HTTPS address to receive messages.",
            },
          ],
        },
      ],
      projects: [{ id: projectId, title: "Selected workspace" }],
    };
    const html = render();
    expect(html).toContain("WhatsApp needs a public HTTPS address to receive messages.");
    expect(html).not.toContain("Channel needs attention");
  });

  it("offers every live project when the channel's project is unavailable", () => {
    const other = ProjectId.make("project-2");
    state.snapshot = {
      bots: [
        {
          id: botId,
          channelBindings: [
            {
              ...binding,
              status: "failed",
              lastError: "private-credential-error",
              sentMessageIds: [],
            },
          ],
        },
      ],
      projects: [{ id: other, title: "Other workspace" }],
    };
    const html = render();
    expect(html).toContain("Connection failed");
    expect(html).toContain("Project unavailable");
    expect(html).toContain("No confirmed deliveries");
    expect(html).toContain("Choose another project to reconnect it.");
    expect(html).toContain("Reconnect in Other workspace");
    expect(html).not.toContain("private-credential-error");
  });

  it("repairs a blocked binding through the change-project command", () => {
    const other = ProjectId.make("project-2");
    state.snapshot = {
      bots: [{ id: botId, channelBindings: [{ ...binding, status: "blocked" }] }],
      projects: [
        { id: projectId, title: "Selected workspace" },
        { id: other, title: "Other workspace" },
      ],
    };
    const html = render();
    expect(html).toContain("Choose another project");
    expect(html).toContain("Reconnect in Selected workspace");
    expect(state.pressables).toHaveLength(2);
    state.pressables[1]!.onPress();
    expect(state.changeProject).toHaveBeenCalledTimes(1);
    expect(state.changeProject).toHaveBeenCalledWith({
      environmentId,
      input: { botId, provider: "telegram", projectId: other },
    });
  });

  it("reports a failed repair", async () => {
    state.changeProject.mockResolvedValue({ _tag: "Failure" });
    state.snapshot = {
      bots: [{ id: botId, channelBindings: [{ ...binding, status: "blocked" }] }],
      projects: [{ id: projectId, title: "Selected workspace" }],
    };
    render();
    state.pressables[0]!.onPress();
    // The command result settles, then the component reports it in the next microtask.
    await state.changeProject.mock.results[0]!.value;
    await Promise.resolve();
    expect(state.alert).toHaveBeenCalledWith("Could not move channel to this project");
  });

  it("explains that a project is needed when none is live", () => {
    state.snapshot = {
      bots: [{ id: botId, channelBindings: [{ ...binding, status: "blocked" }] }],
      projects: [],
    };
    const html = render();
    expect(html).toContain("Add a project before connecting a channel.");
    expect(html).not.toContain("button");
  });

  it("points a standard session at the host instead of offering repair", () => {
    state.session = {
      _tag: "Success",
      value: { authenticated: true, scopes: ["orchestration:read", "orchestration:operate"] },
    };
    state.snapshot = {
      bots: [{ id: botId, channelBindings: [{ ...binding, status: "blocked" }] }],
      projects: [{ id: projectId, title: "Selected workspace" }],
    };
    const html = render();
    expect(html).toContain("Repair this channel from Settings &gt; Bot channels on the host.");
    expect(html).not.toContain("Reconnect in");
    expect(state.pressables).toHaveLength(0);
    expect(state.changeProject).not.toHaveBeenCalled();
  });

  it("treats a pending session as unable to repair", () => {
    state.session = { _tag: "Initial", waiting: true };
    state.snapshot = {
      bots: [{ id: botId, channelBindings: [{ ...binding, status: "blocked" }] }],
      projects: [{ id: projectId, title: "Selected workspace" }],
    };
    const html = render();
    expect(html).toContain("Repair this channel from Settings &gt; Bot channels on the host.");
    expect(state.pressables).toHaveLength(0);
  });

  it("does not show another bot's channels", () => {
    expect(render(BotId.make("other-bot"))).toBe("");
  });

  it("renders nothing before the snapshot loads or after detach", () => {
    state.snapshot = undefined;
    expect(render()).toBe("");
    state.snapshot = { bots: [{ id: botId, channelBindings: [] }], projects: [] };
    expect(render()).toBe("");
  });
});
