import { Predicate } from "effect";
import { AuthAccessWriteScope, type ChannelBinding } from "@akeru/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChannelDetailPage } from "./ChannelDetailPage";

type LegacyBinding = {
  botId: string;
  connectionId?: string;
  provider: "slack" | "discord";
  projectId: string;
  status: ChannelBinding["status"];
  externalIdentity: string | null;
  connectedAt: string | null;
  sentMessageIds: string[];
};

const fixtures = vi.hoisted(() => ({
  bots: [] as Array<{
    id: string;
    name: string;
    archivedAt: string | null;
    channelBindings: LegacyBinding[];
  }>,
  settings: {
    channelConnections: [] as Array<{ id: string; name: string; provider: string }>,
    channelOwners: [] as Array<{ provider: string }>,
    channelBotAccess: [] as Array<{ botId: string }>,
  },
  buttons: new Map<string, () => void>(),
  command: vi.fn(async () => ({ _tag: "Success" as const, value: "ABCD2345" })),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "bots"
      ? fixtures.bots
      : {
          projects: [
            {
              id: "project-1",
              title: "Workspace",
              workspaceRoot: "/work",
              updatedAt: "2026-11-01T00:00:00.000Z",
            },
          ],
          threads: [],
        },
}));

vi.mock("../../state/shell", () => ({ environmentSnapshotAtom: () => "snapshot" }));

vi.mock("../../state/bots", () => ({
  environmentBotsAtom: () => "bots",
  botEnvironment: { channels: {} },
}));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixtures.command }));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: <Selected,>(
    _environmentId: string,
    select: (settings: typeof fixtures.settings) => Selected,
  ) => select(fixtures.settings),
}));

vi.mock("../../settingsDialogStore", () => ({ useSettingsEnvironmentId: () => "environment-1" }));

vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: vi.fn() }));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    isPending: false,
    data: { authenticated: true, scopes: [AuthAccessWriteScope] },
  }),
}));

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

vi.mock("../ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/button")>();

  return {
    ...actual,
    Button: (props: Parameters<typeof actual.Button>[0]) => {
      if (Predicate.isString(props.children) && props.onClick) {
        const onClick = props.onClick;
        fixtures.buttons.set(props.children, () => onClick({} as never));
      }

      return <actual.Button {...props} />;
    },
  };
});

vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./settingsDetailLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsDetailLayout")>()),
  SettingsDetailHeader: ({ title }: { title: string }) => <header>{title}</header>,
}));

const binding = (overrides: Partial<LegacyBinding> = {}): LegacyBinding => ({
  botId: "bot-1",
  provider: "slack",
  projectId: "project-1",
  status: "connected",
  externalIdentity: "U0SCOUT",
  connectedAt: "2026-11-05T10:00:00.000Z",
  sentMessageIds: [],
  ...overrides,
});

const scout = (channelBindings: LegacyBinding[]) => ({
  id: "bot-1",
  name: "Scout",
  archivedAt: null,
  channelBindings,
});

const LEGACY_TITLE = "Connected without a saved connection";

beforeEach(() => {
  fixtures.bots = [];
  fixtures.settings.channelConnections = [];
  fixtures.settings.channelOwners = [];
  fixtures.settings.channelBotAccess = [];
  fixtures.buttons.clear();
  fixtures.command.mockClear();
});

describe("ChannelDetailPage bots connected without a saved connection", () => {
  it("offers a link code for a live Slack binding with no connection and sends its bot", () => {
    fixtures.bots = [scout([binding()])];

    const html = renderToStaticMarkup(<ChannelDetailPage provider="slack" />);

    expect(html).toContain(LEGACY_TITLE);
    expect(html).toContain("Scout");
    expect(html).toContain("Create link code");

    fixtures.buttons.get("Create link code")?.();
    expect(fixtures.command).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { botId: "bot-1", provider: "slack" },
    });
  });

  it("leaves out disconnected, saved-connection, and other-provider bindings", () => {
    fixtures.bots = [
      scout([binding({ status: "disconnected" })]),
      { ...scout([binding({ connectionId: "profile-1" })]), id: "bot-2" },
      { ...scout([binding({ provider: "discord" })]), id: "bot-3" },
    ];

    const html = renderToStaticMarkup(<ChannelDetailPage provider="slack" />);

    expect(html).not.toContain(LEGACY_TITLE);
  });
});
