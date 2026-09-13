import { AuthAccessWriteScope, BotId, ChannelConnectionId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canManageChannels,
  connectedChannelBinding,
  resolveChannelSettingsAccess,
} from "../../channelAccess";
import { bindingFor, selfHostedIMessageConnectInput, whatsAppConnectInput } from "./BotChannelRows";
import {
  assignedBotForConnection,
  channelTestInstructions,
  parsePhotonHostedCredentials,
  providerLabel,
} from "./BotChannelsSettings";

describe("bot channel settings", () => {
  const botId = BotId.make("bot-1");
  const projectId = ProjectId.make("project-1");

  it("shows disconnected live adapters", () => {
    const bot = { id: botId, channelBindings: [] };

    expect(bindingFor(bot, "telegram")).toEqual({
      botId,
      provider: "telegram",
      status: "disconnected",
      externalIdentity: null,
      connectedAt: null,
      sentMessageIds: [],
    });
    expect(bindingFor(bot, "whatsapp").status).toBe("disconnected");
  });

  it("uses a persisted binding", () => {
    const connectedAt = "2026-08-27T20:00:00.000Z";
    expect(
      bindingFor(
        {
          id: botId,
          channelBindings: [
            {
              botId,
              provider: "imessage",
              status: "connected",
              externalIdentity: "+15551234567",
              connectedAt,
              sentMessageIds: [],
            },
          ],
        },
        "imessage",
      ),
    ).toMatchObject({ status: "connected", externalIdentity: "+15551234567", connectedAt });
  });

  it("sends a trimmed Photon phone when self-hosted", () => {
    expect(
      selfHostedIMessageConnectInput(
        botId,
        projectId,
        " photon.test:443 ",
        " secret ",
        " +15551234567 ",
      ),
    ).toEqual({
      botId,
      targetProjectId: projectId,
      provider: "imessage",
      mode: "self-hosted",
      serverUrl: "photon.test:443",
      apiKey: "secret",
      phone: "+15551234567",
    });
    expect(
      selfHostedIMessageConnectInput(botId, projectId, "server", "key", "   "),
    ).not.toHaveProperty("phone");
  });

  it("sends trimmed WhatsApp credentials", () => {
    expect(
      whatsAppConnectInput(
        botId,
        projectId,
        " access-token ",
        " app-secret ",
        " phone-number-id ",
        " verify-token ",
      ),
    ).toEqual({
      botId,
      targetProjectId: projectId,
      provider: "whatsapp",
      accessToken: "access-token",
      appSecret: "app-secret",
      phoneNumberId: "phone-number-id",
      verifyToken: "verify-token",
    });
  });

  it("requires access write scope for channel controls", () => {
    const session = { authenticated: true, auth: { mode: "required" as const } };

    expect(canManageChannels({ ...session, scopes: [AuthAccessWriteScope] })).toBe(true);
    expect(canManageChannels({ ...session, scopes: ["orchestration:operate"] })).toBe(false);
    expect(canManageChannels(null)).toBe(false);
  });

  it("allows Send only for a connected binding", () => {
    const disconnected = bindingFor({ id: botId, channelBindings: [] }, "telegram");
    const connected = { ...disconnected, status: "connected" as const };

    expect(connectedChannelBinding([disconnected], "telegram")).toBeUndefined();
    expect(connectedChannelBinding([connected], "telegram")).toEqual(connected);
  });

  it("keeps pending access neutral until the session loads", () => {
    expect(resolveChannelSettingsAccess({ isPending: true, session: null })).toBe("pending");
    expect(resolveChannelSettingsAccess({ isPending: false, session: null })).toBe("denied");
  });

  it("finds saved connections assigned to archived bots", () => {
    const connectionId = ChannelConnectionId.make("photon-work");
    const bots = [
      {
        id: botId,
        name: "Scout",
        archivedAt: "2026-08-28T20:00:00.000Z",
        channelBindings: [
          {
            botId,
            connectionId,
            provider: "imessage" as const,
            status: "connected" as const,
            externalIdentity: "+15551234567",
            connectedAt: "2026-08-27T20:00:00.000Z",
            sentMessageIds: [],
          },
        ],
      },
    ];

    expect(assignedBotForConnection(connectionId, bots)?.name).toBe("Scout");
    expect(
      assignedBotForConnection(connectionId, [
        {
          ...bots[0]!,
          archivedAt: null,
          channelBindings: [{ ...bots[0]!.channelBindings[0]!, status: "disconnected" }],
        },
      ])?.name,
    ).toBe("Scout");
    expect(assignedBotForConnection(ChannelConnectionId.make("unassigned"), bots)).toBeUndefined();
  });

  it("uses installed adapter names", () => {
    expect(providerLabel("imessage")).toBe("Photon");
    expect(providerLabel("whatsapp")).toBe("Meta Cloud API");
    expect(providerLabel("telegram")).toBe("Telegram Bot API");
    expect(providerLabel("slack")).toBe("Slack Socket Mode");
    expect(providerLabel("discord")).toBe("Discord Gateway");
  });

  it("explains the real end-to-end channel test", () => {
    expect(channelTestInstructions("imessage", "Akeru")).toContain("direct iMessage");
    expect(channelTestInstructions("whatsapp")).toContain("direct WhatsApp");
    expect(channelTestInstructions("telegram")).toContain("direct Telegram");
    expect(channelTestInstructions("slack", "Akeru")).toContain("Slack channel thread");
    expect(channelTestInstructions("discord", "Akeru")).toContain("Discord server");
  });

  it("parses copied Photon environment variables", () => {
    expect(
      parsePhotonHostedCredentials(
        "SPECTRUM_PROJECT_ID=project-1\r\nSPECTRUM_PROJECT_SECRET=secret=with=equals",
      ),
    ).toEqual({ projectId: "project-1", projectSecret: "secret=with=equals" });
  });

  it("rejects incomplete or ambiguous Photon environment variables", () => {
    expect(parsePhotonHostedCredentials("SPECTRUM_PROJECT_ID=project-1")).toBeNull();
    expect(
      parsePhotonHostedCredentials(
        "SPECTRUM_PROJECT_ID=first\nSPECTRUM_PROJECT_ID=second\nSPECTRUM_PROJECT_SECRET=secret",
      ),
    ).toBeNull();
    expect(
      parsePhotonHostedCredentials("OTHER_PROJECT_ID=project-1\nSPECTRUM_PROJECT_SECRET=secret"),
    ).toBeNull();
  });
});
