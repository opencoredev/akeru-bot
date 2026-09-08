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
      status: "disconnected";
      lastError?: string;
      externalIdentity: null;
      connectedAt: null;
      sentMessageIds: string[];
    }>;
  }>,
  projects: [
    { id: "project-uuid", title: "Selected workspace", workspaceRoot: "/Users/leo/code/selected" },
  ],
  connections: [
    { id: "profile-1", name: "Fixture line", provider: "imessage", externalIdentity: null },
  ],
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "bots" ? fixtures.bots : fixtures.projects),
}));
vi.mock("../../state/bots", () => ({
  environmentBotsAtom: () => "bots",
  botEnvironment: { channels: {} },
}));
vi.mock("../../state/projects", () => ({
  environmentProjects: { environmentProjectsAtom: () => "projects" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => fixtures.connections }));
vi.mock("../../settingsDialogStore", () => ({ useSettingsEnvironmentId: () => "environment-1" }));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    isPending: false,
    data: { authenticated: true, scopes: [AuthAccessWriteScope] },
  }),
}));

vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { BotChannelsSettingsPanel } from "./BotChannelsSettings";

describe("channel project selection", () => {
  beforeEach(() => {
    fixtures.bots = [];
  });

  it("asks only for a bot and never exposes a folder or project picker", () => {
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain("Bot that answers");
    expect(html).toContain("Choose a bot");
    expect(html).not.toContain("project");
    expect(html).not.toContain("folder");
    expect(html).not.toContain(">Selected workspace<");
    const trigger = html.match(/<button[^>]*aria-label="Assign Fixture line"[^>]*>/)?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("renders the assigned project and bot names rather than their IDs", () => {
    fixtures.bots = [
      {
        id: "bot-uuid",
        name: "Akeru",
        archivedAt: null,
        channelBindings: [
          {
            botId: "bot-uuid",
            connectionId: "profile-1",
            provider: "imessage",
            projectId: "project-uuid",
            status: "disconnected",
            lastError:
              "Delivery could not be confirmed. Check the external conversation before retrying.",
            externalIdentity: null,
            connectedAt: null,
            sentMessageIds: [],
          },
        ],
      },
    ];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain(">Akeru<");
    expect(html).not.toContain(">project-uuid<");
    expect(html).not.toContain(">bot-uuid<");
    expect(html).toContain('role="status"');
    expect(html).toContain(
      "Delivery could not be confirmed. Check the external conversation before retrying.",
    );
  });
});
