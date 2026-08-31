import { AuthAccessWriteScope, BotId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canManageChannels,
  connectedChannelBinding,
  resolveChannelSettingsAccess,
} from "../../channelAccess";
import { bindingFor } from "./BotChannelRows";

describe("bot channel settings", () => {
  const botId = BotId.make("bot-1");

  it("shows disconnected live adapters and an unavailable WhatsApp state", () => {
    const bot = { id: botId, channelBindings: [] };

    expect(bindingFor(bot, "telegram")).toEqual({
      botId,
      provider: "telegram",
      status: "disconnected",
      externalIdentity: null,
      connectedAt: null,
      sentMessageIds: [],
    });
    expect(bindingFor(bot, "whatsapp").status).toBe("not-live");
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
