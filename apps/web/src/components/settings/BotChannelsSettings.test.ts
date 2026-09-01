import { AuthAccessWriteScope, BotId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canManageChannels,
  connectedChannelBinding,
  resolveChannelSettingsAccess,
} from "../../channelAccess";
import { bindingFor, selfHostedIMessageConnectInput, whatsAppConnectInput } from "./BotChannelRows";

describe("bot channel settings", () => {
  const botId = BotId.make("bot-1");

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
      selfHostedIMessageConnectInput(botId, " photon.test:443 ", " secret ", " +15551234567 "),
    ).toEqual({
      botId,
      provider: "imessage",
      mode: "self-hosted",
      serverUrl: "photon.test:443",
      apiKey: "secret",
      phone: "+15551234567",
    });
    expect(selfHostedIMessageConnectInput(botId, "server", "key", "   ")).not.toHaveProperty(
      "phone",
    );
  });

  it("sends trimmed WhatsApp credentials", () => {
    expect(
      whatsAppConnectInput(
        botId,
        " access-token ",
        " app-secret ",
        " phone-number-id ",
        " verify-token ",
      ),
    ).toEqual({
      botId,
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
});
