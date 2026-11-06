import { Predicate } from "effect";
import { BotId, EnvironmentId } from "@akeru/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ChannelBotAccessControls,
  ChannelLinkedAccounts,
  parseAllowedUserIds,
} from "./ChannelOwnerAccess";

const fixtures = vi.hoisted(() => ({
  settings: {
    channelOwners: [] as Array<{
      provider: "slack" | "discord";
      workspaceId: string;
      userId: string;
      displayName?: string;
      linkedAt: string;
    }>,
    channelBotAccess: [] as Array<{
      botId: string;
      allowedUserIds: string[];
      replyToOthers: boolean;
    }>,
  },
  buttons: new Map<string, () => void>(),
  command: vi.fn(async () => ({ _tag: "Success" as const, value: 0 })),
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: <Selected,>(
    _environmentId: string,
    select: (settings: typeof fixtures.settings) => Selected,
  ) => select(fixtures.settings),
}));

vi.mock("../../state/bots", () => ({ botEnvironment: { channels: {} } }));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixtures.command }));

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

const environmentId = EnvironmentId.make("environment-1");

const botId = BotId.make("bot-1");

beforeEach(() => {
  fixtures.settings.channelOwners = [];
  fixtures.settings.channelBotAccess = [];
  fixtures.buttons.clear();
  fixtures.command.mockClear();
});

describe("ChannelLinkedAccounts", () => {
  it("explains linking when no account is linked", () => {
    const html = renderToStaticMarkup(
      <ChannelLinkedAccounts environmentId={environmentId} provider="slack" />,
    );

    expect(html).toContain("No linked accounts yet. Bots answer only linked accounts.");
  });

  it("lists this provider's linked accounts and unlinks one", () => {
    fixtures.settings.channelOwners = [
      {
        provider: "slack",
        workspaceId: "T123",
        userId: "U123",
        displayName: "Leo",
        linkedAt: "2026-10-01T00:00:00.000Z",
      },
      { provider: "discord", workspaceId: "discord", userId: "999", linkedAt: "2026-10-01" },
    ];

    const html = renderToStaticMarkup(
      <ChannelLinkedAccounts environmentId={environmentId} provider="slack" />,
    );

    expect(html).toContain("Leo");
    expect(html).toContain("U123 in workspace T123");
    expect(html).not.toContain("999");

    fixtures.buttons.get("Unlink")?.();
    expect(fixtures.command).toHaveBeenCalledWith({
      environmentId,
      input: { provider: "slack", workspaceId: "T123", userId: "U123" },
    });
  });
});

describe("ChannelBotAccessControls", () => {
  it("shows the saved allowlist and reply setting, with save off until something changes", () => {
    fixtures.settings.channelBotAccess = [
      { botId, allowedUserIds: ["U1", "U2"], replyToOthers: true },
    ];

    const html = renderToStaticMarkup(
      <ChannelBotAccessControls
        environmentId={environmentId}
        provider="slack"
        botId={botId}
        botName="Scout"
        connected
        connectedAt="2026-11-05T10:00:00.000Z"
      />,
    );

    expect(html).toContain('value="U1, U2"');
    expect(html).toContain("Also answer these Slack user IDs");
    expect(html).toMatch(
      /role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/u,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/u);
    expect(html).toContain("Create link code");
  });

  it("asks the server for a link code for this bot", () => {
    renderToStaticMarkup(
      <ChannelBotAccessControls
        environmentId={environmentId}
        provider="discord"
        botId={botId}
        botName="Scout"
        connected
        connectedAt="2026-11-05T10:00:00.000Z"
      />,
    );

    fixtures.buttons.get("Create link code")?.();
    expect(fixtures.command).toHaveBeenCalledWith({
      environmentId,
      input: { botId, provider: "discord" },
    });
  });
});

describe("parseAllowedUserIds", () => {
  it("splits on commas, spaces, and new lines and drops repeats", () => {
    expect(parseAllowedUserIds(" U1, U2\nU3  U1,,")).toEqual(["U1", "U2", "U3"]);
  });
});
