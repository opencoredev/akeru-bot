import { ChannelConnectionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildChannelConnectionSaveInput } from "./ChannelSetupDialog";
import {
  CHANNEL_PROVIDER_META,
  channelProviderMeta,
  discordInviteUrl,
  slackPasteTarget,
} from "./channelProviderMeta";

describe("channel provider metadata", () => {
  it("describes all five providers with icons, steps, and console links", () => {
    expect(CHANNEL_PROVIDER_META.map((meta) => meta.provider)).toEqual([
      "imessage",
      "whatsapp",
      "telegram",
      "slack",
      "discord",
    ]);
    for (const meta of CHANNEL_PROVIDER_META) {
      expect(meta.icon).toBeTypeOf("function");
      expect(meta.steps.length).toBeGreaterThanOrEqual(2);
      expect(meta.consoleUrl).toMatch(/^https:\/\//u);
      expect(meta.fields.length).toBeGreaterThan(0);
    }
  });

  it("splits Photon fields by connection mode", () => {
    const fields = channelProviderMeta("imessage").fields;
    expect(fields.filter((field) => field.mode === "hosted").map((field) => field.key)).toEqual([
      "projectId",
      "projectSecret",
    ]);
    expect(
      fields.filter((field) => field.mode === "self-hosted").map((field) => field.key),
    ).toEqual(["serverUrl", "apiKey", "phone"]);
    expect(fields.find((field) => field.key === "phone")?.optional).toBe(true);
  });
});

describe("discordInviteUrl", () => {
  it("builds an invite link only from a plausible application ID", () => {
    expect(discordInviteUrl("123456789012345678")).toBe(
      "https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot&permissions=397552987200",
    );
    expect(discordInviteUrl(" 123456789012345678 ")).toContain("123456789012345678");
    expect(discordInviteUrl("not-an-id")).toBeNull();
    expect(discordInviteUrl("")).toBeNull();
    expect(discordInviteUrl("123")).toBeNull();
  });
});

describe("slackPasteTarget", () => {
  it("routes tokens by prefix and ignores everything else", () => {
    expect(slackPasteTarget("xoxb-1234-abc")).toBe("botToken");
    expect(slackPasteTarget("  xapp-1-A1-xyz  ")).toBe("appToken");
    expect(slackPasteTarget("hello")).toBeNull();
  });
});

describe("buildChannelConnectionSaveInput", () => {
  const connectionId = ChannelConnectionId.make("channel-test");

  it("builds each provider's command shape and trims values", () => {
    expect(
      buildChannelConnectionSaveInput({
        connectionId,
        name: "Line",
        provider: "telegram",
        mode: "hosted",
        values: { token: " 123:abc " },
      }),
    ).toEqual({ connectionId, name: "Line", provider: "telegram", token: "123:abc" });
    expect(
      buildChannelConnectionSaveInput({
        connectionId,
        name: "Line",
        provider: "slack",
        mode: "hosted",
        values: { botToken: "xoxb-1", appToken: "xapp-1" },
      }),
    ).toMatchObject({ provider: "slack", botToken: "xoxb-1", appToken: "xapp-1" });
    expect(
      buildChannelConnectionSaveInput({
        connectionId,
        name: "Line",
        provider: "discord",
        mode: "hosted",
        values: { applicationId: "1", publicKey: "2", botToken: "3" },
      }),
    ).toMatchObject({ provider: "discord", applicationId: "1", publicKey: "2", botToken: "3" });
    expect(
      buildChannelConnectionSaveInput({
        connectionId,
        name: "Line",
        provider: "whatsapp",
        mode: "hosted",
        values: { accessToken: "a", appSecret: "b", phoneNumberId: "c", verifyToken: "d" },
      }),
    ).toMatchObject({ provider: "whatsapp", accessToken: "a", verifyToken: "d" });
  });

  it("builds both Photon modes and omits a blank phone", () => {
    expect(
      buildChannelConnectionSaveInput({
        connectionId,
        name: "Line",
        provider: "imessage",
        mode: "hosted",
        values: { projectId: "p", projectSecret: "s" },
      }),
    ).toEqual({
      connectionId,
      name: "Line",
      provider: "imessage",
      mode: "hosted",
      projectId: "p",
      projectSecret: "s",
    });
    const selfHosted = buildChannelConnectionSaveInput({
      connectionId,
      name: "Line",
      provider: "imessage",
      mode: "self-hosted",
      values: { serverUrl: "https://x", apiKey: "k", phone: "  " },
    });
    expect(selfHosted).toEqual({
      connectionId,
      name: "Line",
      provider: "imessage",
      mode: "self-hosted",
      serverUrl: "https://x",
      apiKey: "k",
    });
  });
});
