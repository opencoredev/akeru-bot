import { AuthAccessWriteScope, type ChannelBinding } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixtures = vi.hoisted(() => ({
  bots: [] as Array<{
    id: string;
    name: string;
    archivedAt: null;
    channelBindings: Array<{
      botId: string;
      connectionId: string;
      provider: "imessage";
      projectId: string;
      status: ChannelBinding["status"];
      lastError?: string;
      failureCategory?: ChannelBinding["failureCategory"];
      externalIdentity: null;
      connectedAt: null;
      sentMessageIds: string[];
    }>;
  }>,
  projects: [
    {
      id: "project-uuid",
      title: "Selected workspace",
      workspaceRoot: "/Users/leo/code/selected",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  ] as Array<{ id: string; title: string; workspaceRoot: string; updatedAt: string }>,
  connections: [
    { id: "profile-1", name: "Fixture line", provider: "imessage", externalIdentity: null },
  ] as Array<Record<string, unknown>>,
  scopes: [] as string[],
  selects: [] as Array<{ onValueChange?: (value: string | null) => void }>,
  command: vi.fn(),
  toast: vi.fn(),
  hash: "",
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "bots" ? fixtures.bots : { projects: fixtures.projects, threads: [] },
}));
vi.mock("../../state/shell", () => ({ environmentSnapshotAtom: () => "snapshot" }));
vi.mock("../../state/bots", () => ({
  environmentBotsAtom: () => "bots",
  botEnvironment: { channels: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixtures.command }));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => fixtures.connections }));
vi.mock("../ui/toast", () => ({ toastManager: { add: fixtures.toast } }));
vi.mock("../../settingsDialogStore", () => ({ useSettingsEnvironmentId: () => "environment-1" }));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    isPending: false,
    data: { authenticated: true, scopes: fixtures.scopes },
  }),
}));

vi.mock("../ui/select", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/select")>();
  return {
    ...actual,
    Select: (props: Parameters<typeof actual.Select>[0]) => {
      fixtures.selects.push(props as (typeof fixtures.selects)[number]);
      return <actual.Select {...props} />;
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { hash: string }) => string }) =>
    select({ hash: fixtures.hash }),
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { BotChannelsSettingsPanel } from "./BotChannelsSettings";

const liveProject = fixtures.projects[0]!;

function boundBot(
  status: ChannelBinding["status"],
  lastError?: string,
  failureCategory?: ChannelBinding["failureCategory"],
) {
  return {
    id: "bot-uuid",
    name: "Akeru",
    archivedAt: null,
    channelBindings: [
      {
        botId: "bot-uuid",
        connectionId: "profile-1",
        provider: "imessage" as const,
        projectId: "project-uuid",
        status,
        ...(lastError ? { lastError } : {}),
        ...(failureCategory ? { failureCategory } : {}),
        externalIdentity: null,
        connectedAt: null,
        sentMessageIds: [],
      },
    ],
  };
}

function trigger(html: string, label: string) {
  return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
}

describe("channel project selection", () => {
  beforeEach(() => {
    fixtures.bots = [];
    fixtures.projects = [liveProject];
    fixtures.selects = [];
    fixtures.scopes = [AuthAccessWriteScope];
    fixtures.command.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("opens on the provider a repair link names", () => {
    fixtures.hash = "#channel-telegram";
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    fixtures.hash = "";
    expect(html).toMatch(/<button[^>]*id="channel-telegram"[^>]*aria-selected="true"/);
    expect(html).toMatch(/<button[^>]*id="channel-imessage"[^>]*aria-selected="false"/);
  });

  it("preselects a live project for an unassigned connection and allows assignment", () => {
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain("Bot that answers");
    expect(html).toContain("Choose a bot");
    expect(html).toContain(">Selected workspace<");
    expect(html).not.toContain("/Users/leo/code/selected");
    expect(trigger(html, "Project for Fixture line")).toBeDefined();
    const assign = trigger(html, "Assign Fixture line");
    expect(assign).toBeDefined();
    expect(assign).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("shows an empty state and blocks assignment when no project is live", () => {
    fixtures.projects = [];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain("Add a project before connecting a channel.");
    expect(trigger(html, "Project for Fixture line")).toBeUndefined();
    expect(trigger(html, "Assign Fixture line")).toMatch(/\sdisabled(=|\s|>)/);
  });

  it("still unassigns a channel when no project is live", async () => {
    fixtures.bots = [boundBot("blocked")];
    fixtures.projects = [];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain("Add a project before connecting a channel.");
    expect(trigger(html, "Assign Fixture line")).not.toMatch(/\sdisabled(=|\s|>)/);
    // The assignment picker is the only Select on the card while the project picker is empty.
    expect(fixtures.selects).toHaveLength(1);
    fixtures.selects[0]!.onValueChange?.("unassigned");
    await fixtures.command.mock.results[0]!.value;
    expect(fixtures.command).toHaveBeenCalledTimes(1);
    expect(fixtures.command).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { botId: "bot-uuid", provider: "imessage" },
    });
  });

  it("renders a blocked binding with repair copy and a project repair action", () => {
    fixtures.bots = [boundBot("blocked", "private-server-detail")];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain("Choose another project");
    expect(html).toContain(
      "The project for this channel is unavailable. Choose another project to reconnect it.",
    );
    expect(html).toContain("Reconnect in this project");
    expect(html).not.toContain(">Reconnect<");
    expect(html).not.toContain("private-server-detail");
  });

  it("asks for a project when the bound project was removed", () => {
    fixtures.bots = [boundBot("connected")];
    fixtures.projects = [{ ...liveProject, id: "project-other", title: "Other workspace" }];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain("Choose another project");
    expect(html).toContain(">Other workspace<");
    expect(html).toContain("Reconnect in this project");
  });

  it("does not offer a move while the running project is selected", () => {
    fixtures.bots = [boundBot("connected")];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain("Assigned to Akeru");
    expect(html).not.toContain("Move to this project");
    expect(html).not.toContain("Reconnect in this project");
  });

  it("renders the assigned project and bot names rather than their IDs", () => {
    fixtures.bots = [
      boundBot(
        "disconnected",
        "Delivery could not be confirmed. Check the external conversation before retrying.",
      ),
    ];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain(">Akeru<");
    expect(html).toContain(">Selected workspace<");
    expect(html).not.toContain(">project-uuid<");
    expect(html).not.toContain(">bot-uuid<");
    expect(html).toContain('role="status"');
    expect(html).toContain(
      "Delivery could not be confirmed. Check the external conversation before retrying.",
    );
  });
});

const fixtureConnection = {
  id: "profile-1",
  name: "Fixture line",
  provider: "imessage",
  externalIdentity: null,
};

function button(html: string, label: string) {
  return html.match(new RegExp(`<(?:button|a)[^>]*>${label}</(?:button|a)>`))?.[0];
}

describe("channel health and repair", () => {
  beforeEach(() => {
    fixtures.bots = [];
    fixtures.projects = [liveProject];
    fixtures.connections = [fixtureConnection];
    fixtures.selects = [];
    fixtures.scopes = [AuthAccessWriteScope];
  });

  it("shows a still connecting channel without a repair action", () => {
    fixtures.bots = [boundBot("connecting")];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain(">Connecting…<");
    expect(button(html, "Connecting…")).toMatch(/\sdisabled(=|\s|>)/);
    expect(button(html, "Reconnect")).toBeUndefined();
    expect(button(html, "Disconnect")).toBeUndefined();
  });

  it("explains a not live channel and shows the webhook URL from the profile", () => {
    fixtures.connections = [
      { ...fixtureConnection, webhookUrl: "https://akeru.example.com/channels/whatsapp/hook" },
    ];
    fixtures.bots = [boundBot("not-live")];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain(">Not live<");
    expect(html).toContain("WhatsApp needs a public HTTPS address to receive messages.");
    expect(html).toContain("https://akeru.example.com/channels/whatsapp/hook");
    expect(button(html, "Reconnect")).toBeUndefined();
    expect(button(html, "Connect")).toBeUndefined();
  });

  it("omits the webhook line when the profile has no webhook URL", () => {
    fixtures.bots = [boundBot("not-live")];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain(">Not live<");
    expect(html).not.toContain("Webhook URL");
  });

  it.each([
    ["failed", "credentials", "Connection failed", "Update credentials"],
    ["failed", "network", "Connection failed", "Reconnect"],
    ["needs-reconnect", undefined, "Needs reconnect", "Reconnect"],
    ["disconnected", undefined, "Disconnected · Akeru", "Connect"],
    ["connected", "credentials", "Needs attention · Akeru", "Update credentials"],
    ["connected", "network", "Needs attention · Akeru", "Reconnect"],
    ["connected", "restore", "Needs attention · Akeru", "Reconnect"],
  ] as const)("%s with %s failure shows one %s repair", (status, category, badge, repair) => {
    fixtures.bots = [boundBot(status, category ? "Fixed server copy." : undefined, category)];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain(`>${badge}<`);
    expect(button(html, repair)).toBeDefined();
    expect(button(html, repair)).not.toMatch(/\sdisabled(=|\s|>)/);
    const repairs = ["Connect", "Reconnect", "Update credentials", "Reconnect in this project"];
    expect(repairs.filter((label) => button(html, label))).toEqual([repair]);
    if (category) expect(html).toContain("Fixed server copy.");
  });

  it("links a connected channel with unknown delivery to the provider console", () => {
    fixtures.connections = [
      { ...fixtureConnection, managementUrl: "https://provider.example.com/console" },
    ];
    fixtures.bots = [
      boundBot(
        "connected",
        "Delivery could not be confirmed. Check the external conversation before retrying.",
        "delivery-unknown",
      ),
    ];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain(">Needs attention · Akeru<");
    expect(button(html, "Check the channel")).toContain(
      'href="https://provider.example.com/console"',
    );
    expect(button(html, "Open provider")).toBeUndefined();
    expect(button(html, "Reconnect")).toBeUndefined();
    expect(button(html, "Disconnect")).toBeDefined();
  });

  it("keeps reconnect available when delivery is unknown and the connection failed", () => {
    fixtures.bots = [boundBot("failed", "Delivery is unconfirmed.", "delivery-unknown")];
    fixtures.connections = [
      { ...fixtureConnection, managementUrl: "https://provider.example.com/console" },
    ];
    const withConsole = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(button(withConsole, "Check the channel")).toContain(
      'href="https://provider.example.com/console"',
    );
    expect(button(withConsole, "Reconnect")).toBeDefined();
    expect(withConsole).toContain("Delivery is unconfirmed.");

    fixtures.connections = [fixtureConnection];
    const withoutConsole = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(button(withoutConsole, "Check the channel")).toBeUndefined();
    expect(button(withoutConsole, "Reconnect")).toBeDefined();
    expect(withoutConsole).toContain("Delivery is unconfirmed.");
  });

  it("shows no repair for a healthy connected channel", () => {
    fixtures.bots = [boundBot("connected")];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain(">Assigned to Akeru<");
    expect(html).not.toContain('role="status"');
    expect(button(html, "Disconnect")).toBeDefined();
    for (const label of ["Connect", "Reconnect", "Update credentials", "Check the channel"]) {
      expect(button(html, label)).toBeUndefined();
    }
  });

  it("hides channel management from a client without write access", () => {
    fixtures.scopes = [];
    fixtures.bots = [boundBot("failed", "Fixed server copy.", "credentials")];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain("This client does not have permission to manage channels.");
    expect(html).not.toContain("Fixture line");
    expect(html).not.toContain("Update credentials");
  });
});

describe("channel identity conflicts", () => {
  beforeEach(() => {
    fixtures.bots = [];
    fixtures.projects = [liveProject];
    fixtures.connections = [fixtureConnection];
    fixtures.selects = [];
    fixtures.scopes = [AuthAccessWriteScope];
    fixtures.toast.mockReset();
  });

  it("explains that another bot already uses the account", async () => {
    fixtures.command.mockReset().mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("This channel connection is attached to another bot.")),
    });
    renderToStaticMarkup(<BotChannelsSettingsPanel />);
    fixtures.selects[0]!.onValueChange?.("bot-uuid");
    await fixtures.command.mock.results[0]!.value;
    await Promise.resolve();
    expect(fixtures.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not assign channel",
      description: "Another bot already uses this account. Unassign it there, then connect again.",
    });
  });
});
