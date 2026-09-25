import { AuthAccessWriteScope } from "@t3tools/contracts";
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
      status: "disconnected" | "blocked" | "connected";
      lastError?: string;
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
  ],
  selects: [] as Array<{ onValueChange?: (value: string | null) => void }>,
  command: vi.fn(),
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
vi.mock("../../settingsDialogStore", () => ({ useSettingsEnvironmentId: () => "environment-1" }));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    isPending: false,
    data: { authenticated: true, scopes: [AuthAccessWriteScope] },
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

vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { BotChannelsSettingsPanel } from "./BotChannelsSettings";

const liveProject = fixtures.projects[0]!;

function boundBot(status: "disconnected" | "blocked" | "connected", lastError?: string) {
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
    fixtures.command.mockReset().mockResolvedValue({ _tag: "Success" });
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
