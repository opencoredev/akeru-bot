import { describe, expect, it } from "@effect/vitest";

import { BotId, MessageId, ProjectId, type ChannelBinding } from "@t3tools/contracts";
import {
  canChangeChannelProject,
  channelBindingNeedsProject,
  channelBindingPresentation,
  channelPickerProjectId,
  channelRestoreProjectId,
  channelHealthLabel,
  channelOriginLabel,
  channelProviderLabel,
  channelRepairAction,
  channelRepairLabel,
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
      channelHealthLabel("connecting"),
      channelHealthLabel("connected"),
      channelHealthLabel("disconnected"),
      channelHealthLabel("needs-reconnect"),
      channelHealthLabel("failed"),
      channelHealthLabel("blocked"),
      channelHealthLabel("not-live"),
    ]).toEqual([
      "Connecting",
      "Connected",
      "Disconnected",
      "Reconnect required",
      "Connection failed",
      "Choose another project",
      "Not live",
    ]);
  });

  it("derives one repair action from status and failure category", () => {
    const projectId = ProjectId.make("project-1");
    const live = [{ id: projectId }];
    const at = (
      status: ChannelBinding["status"],
      failureCategory?: ChannelBinding["failureCategory"],
    ) => channelRepairAction({ status, projectId, failureCategory }, live);
    expect(at("connecting")).toBe("wait");
    expect(at("connected")).toBe("none");
    expect(at("connected", "delivery-unknown")).toBe("check-delivery");
    expect(at("connected", "credentials")).toBe("update-credentials");
    expect(at("connected", "network")).toBe("reconnect");
    expect(at("disconnected")).toBe("connect");
    expect(at("needs-reconnect", "network")).toBe("reconnect");
    expect(at("failed", "credentials")).toBe("update-credentials");
    expect(at("failed", "delivery-unknown")).toBe("check-delivery");
    expect(at("failed", "network")).toBe("reconnect");
    expect(at("failed", "restore")).toBe("reconnect");
    expect(at("failed", "project")).toBe("choose-project");
    expect(at("blocked")).toBe("choose-project");
    expect(at("not-live")).toBe("configure-public-url");
    expect(
      channelRepairAction({ status: "failed", projectId, failureCategory: "credentials" }, []),
    ).toBe("choose-project");
    expect(
      channelRepairAction({ status: "failed", projectId, failureCategory: "delivery-unknown" }, []),
    ).toBe("choose-project");
    expect(
      channelRepairAction({ status: "failed", projectId, failureCategory: "credentials" }),
    ).toBe("update-credentials");
    expect(channelRepairLabel("none")).toBeNull();
    expect(channelRepairLabel("update-credentials")).toBe("Update credentials");
    expect(channelRepairLabel(at("failed", "delivery-unknown"))).toBe("Check the channel");
  });

  it("reports only confirmed deliveries and does not choose a default project", () => {
    expect(channelBindingPresentation(binding, [])).toEqual({
      provider: "Slack",
      health: "Connected",
      needsProjectConfirmation: true,
      warning: "Choose a project before reconnecting",
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
    const projectId = ProjectId.make("project-1");
    const presentation = channelBindingPresentation(
      { ...binding, projectId, lastError: "private-error-detail" },
      [{ id: projectId, title: "Workspace" }],
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

  it("restores a failed reassignment to a live project", () => {
    const live = ProjectId.make("project-live");
    const gone = ProjectId.make("project-gone");
    const target = ProjectId.make("project-target");
    const projects = [
      { id: live, title: "Workspace" },
      { id: target, title: "Target" },
    ];
    expect(channelRestoreProjectId(live, target, projects)).toBe(live);
    expect(channelRestoreProjectId(gone, target, projects)).toBe(target);
    expect(channelRestoreProjectId(undefined, target, projects)).toBe(target);
  });

  it("asks for a live project when the binding is blocked or its project is gone", () => {
    const live = ProjectId.make("project-live");
    const gone = ProjectId.make("project-gone");
    const projects = [{ id: live, title: "Workspace" }];
    expect(channelBindingNeedsProject({ status: "connected", projectId: live }, projects)).toBe(
      false,
    );
    expect(channelBindingNeedsProject({ status: "blocked", projectId: live }, projects)).toBe(true);
    expect(channelBindingNeedsProject({ status: "connected", projectId: gone }, projects)).toBe(
      true,
    );
    expect(channelBindingNeedsProject({ status: "failed" }, projects)).toBe(true);
    const blocked = channelBindingPresentation(
      { ...binding, status: "blocked", projectId: gone, lastError: "private" },
      projects,
    );
    expect(blocked.health).toBe("Choose another project");
    expect(blocked.warning).toBe("Choose a project before reconnecting");
    expect(blocked.needsProjectConfirmation).toBe(true);
  });

  it("picks the explicit choice, then the running project, then a live hint", () => {
    const first = ProjectId.make("project-1");
    const second = ProjectId.make("project-2");
    const gone = ProjectId.make("project-gone");
    const liveProjects = [{ id: first }, { id: second }];
    const running = { status: "connected" as const, projectId: first };
    expect(
      channelPickerProjectId({ selected: second, binding: running, hint: first, liveProjects }),
    ).toBe(second);
    expect(
      channelPickerProjectId({ selected: gone, binding: running, hint: second, liveProjects }),
    ).toBe(first);
    expect(
      channelPickerProjectId({
        selected: null,
        binding: { status: "blocked", projectId: gone },
        hint: second,
        liveProjects,
      }),
    ).toBe(second);
    expect(
      channelPickerProjectId({ selected: undefined, binding: undefined, hint: gone, liveProjects }),
    ).toBeNull();
    expect(
      channelPickerProjectId({ selected: null, binding: undefined, hint: null, liveProjects: [] }),
    ).toBeNull();
  });

  it("allows a project change only to a different live project or to repair a blocked binding", () => {
    const first = ProjectId.make("project-1");
    const second = ProjectId.make("project-2");
    const liveProjects = [{ id: first }, { id: second }];
    const running = { status: "connected" as const, projectId: first };
    expect(canChangeChannelProject(running, first, liveProjects)).toBe(false);
    expect(canChangeChannelProject(running, second, liveProjects)).toBe(true);
    expect(canChangeChannelProject(running, null, liveProjects)).toBe(false);
    expect(canChangeChannelProject(running, ProjectId.make("gone"), liveProjects)).toBe(false);
    expect(
      canChangeChannelProject({ status: "blocked", projectId: first }, first, liveProjects),
    ).toBe(true);
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
