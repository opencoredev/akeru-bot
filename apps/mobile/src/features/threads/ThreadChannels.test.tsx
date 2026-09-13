import { BotId, EnvironmentId, MessageId, ProjectId } from "@t3tools/contracts";
import type { ChannelBinding } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ snapshot: undefined as unknown }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.snapshot }));
vi.mock("../../state/shell", () => ({ environmentSnapshotAtom: (id: string) => id }));
vi.mock("react-native", () => ({ Text: "span", View: "div" }));

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
  lastError: "private-credential-error",
  sentMessageIds: [MessageId.make("message-1")],
};

function render(bot = botId) {
  const tree = ThreadChannels({ environmentId, botId: bot });
  return tree === null ? "" : JSON.stringify(tree);
}

describe("mobile thread channels", () => {
  beforeEach(() => {
    state.snapshot = {
      bots: [{ id: botId, channelBindings: [binding] }],
      projects: [{ id: projectId, title: "Selected workspace" }],
    };
  });

  it("renders read-only health, selected project, and confirmed delivery from the snapshot", () => {
    const html = render();
    expect(html).toContain("Telegram");
    expect(html).toContain("Connected");
    expect(html).toContain("Selected workspace");
    expect(html).toContain("1 confirmed delivery");
    expect(html).not.toContain("private-");
    expect(html).not.toContain("button");
    expect(html).not.toContain("input");
  });

  it("renders changed health and missing project without using another project", () => {
    state.snapshot = {
      bots: [
        { id: botId, channelBindings: [{ ...binding, status: "failed", sentMessageIds: [] }] },
      ],
      projects: [{ id: "other-project", title: "Wrong workspace" }],
    };
    const html = render();
    expect(html).toContain("Connection failed");
    expect(html).toContain("Project unavailable");
    expect(html).toContain("No confirmed deliveries");
    expect(html).not.toContain("Wrong workspace");
    expect(html).not.toContain("private-credential-error");
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
