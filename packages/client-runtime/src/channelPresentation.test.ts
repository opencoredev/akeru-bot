import { describe, expect, it } from "@effect/vitest";

import { BotId, MessageId, ProjectId, type ChannelBinding } from "@t3tools/contracts";
import {
  channelBindingPresentation,
  channelHealthLabel,
  channelOriginLabel,
  channelProviderLabel,
} from "./channelPresentation.ts";

describe("channel presentation", () => {
  const binding: ChannelBinding = {
    botId: BotId.make("bot-1"),
    provider: "slack",
    status: "connected",
    externalIdentity: null,
    connectedAt: null,
    sentMessageIds: [],
  };

  it("labels every health state without exposing raw errors", () => {
    expect([
      channelHealthLabel("connected"),
      channelHealthLabel("disconnected"),
      channelHealthLabel("needs-reconnect"),
      channelHealthLabel("failed"),
      channelHealthLabel("not-live"),
    ]).toEqual([
      "Connected",
      "Disconnected",
      "Reconnect required",
      "Connection failed",
      "Not live",
    ]);
  });

  it("reports only confirmed deliveries and does not choose a default project", () => {
    expect(channelBindingPresentation(binding, [])).toEqual({
      provider: "Slack",
      health: "Connected",
      warning: null,
      project: "No project selected",
      delivery: "No confirmed deliveries",
    });
    const id = MessageId.make("message-1");
    expect(channelBindingPresentation({ ...binding, sentMessageIds: [id, id] }, []).delivery).toBe(
      "1 confirmed delivery",
    );
    expect(
      channelBindingPresentation(
        { ...binding, sentMessageIds: [id, MessageId.make("message-2")] },
        [],
      ).delivery,
    ).toBe("2 confirmed deliveries");
  });

  it("shows a repair warning without exposing error details", () => {
    const presentation = channelBindingPresentation(
      { ...binding, lastError: "private-error-detail" },
      [],
    );
    expect(presentation.warning).toBe("Channel needs attention");
    expect(JSON.stringify(presentation)).not.toContain("private-error-detail");
  });

  it("resolves only the assigned project", () => {
    const projectId = ProjectId.make("project-1");
    expect(channelBindingPresentation({ ...binding, projectId }, []).project).toBe(
      "Project unavailable",
    );
    expect(
      channelBindingPresentation({ ...binding, projectId }, [{ id: projectId, title: "Workspace" }])
        .project,
    ).toBe("Workspace");
  });

  it("falls back to the sender ID and permits an absent sender", () => {
    expect(
      channelOriginLabel(
        { provider: "discord", externalThreadId: "thread", externalSenderId: "sender" },
        "  ",
      ),
    ).toBe("Discord · sender");
    expect(channelOriginLabel({ provider: "imessage", externalThreadId: "thread" })).toBe(
      "iMessage",
    );
  });
  it("labels every advertised provider", () => {
    expect([
      channelProviderLabel("telegram"),
      channelProviderLabel("imessage"),
      channelProviderLabel("whatsapp"),
      channelProviderLabel("slack"),
      channelProviderLabel("discord"),
    ]).toEqual(["Telegram", "iMessage", "WhatsApp", "Slack", "Discord"]);
  });

  it("prefers the persisted sender display name", () => {
    expect(
      channelOriginLabel(
        {
          provider: "slack",
          externalThreadId: "slack:C1:1",
          externalSenderId: "U1",
        },
        "Alice",
      ),
    ).toBe("Slack · Alice");
  });
});
