import type {
  ChannelBinding,
  ChannelBindingStatus,
  ChannelMessageOrigin,
  ChannelProvider,
  ProjectId,
} from "@t3tools/contracts";

type ProjectRef = { readonly id: ProjectId };

export function channelProviderLabel(provider: ChannelProvider): string {
  if (provider === "imessage") return "iMessage";
  if (provider === "whatsapp") return "WhatsApp";
  if (provider === "telegram") return "Telegram";
  if (provider === "slack") return "Slack";
  return "Discord";
}

export function channelHealthLabel(status: ChannelBindingStatus): string {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "disconnected":
      return "Disconnected";
    case "needs-reconnect":
      return "Reconnect required";
    case "failed":
      return "Connection failed";
    case "blocked":
      return "Choose another project";
    case "not-live":
      return "Not live";
  }
}

/** The single repair a client offers for a binding. */
export type ChannelRepairAction =
  | "none"
  | "wait"
  | "connect"
  | "reconnect"
  | "update-credentials"
  | "choose-project"
  | "check-delivery"
  | "configure-public-url";

/**
 * Picks one repair action from status and failure category. With `liveProjects`, a binding whose
 * project is gone asks for a project first, because every other repair would start it there.
 */
export function channelRepairAction(
  binding: Pick<ChannelBinding, "status" | "projectId" | "failureCategory">,
  liveProjects?: ReadonlyArray<ProjectRef>,
): ChannelRepairAction {
  if (binding.status === "connecting") return "wait";
  if (binding.status === "not-live") return "configure-public-url";
  if (
    binding.status === "blocked" ||
    binding.failureCategory === "project" ||
    (liveProjects && channelBindingNeedsProject(binding, liveProjects))
  ) {
    return "choose-project";
  }
  if (
    binding.failureCategory === "delivery-unknown" &&
    (binding.status === "connected" || binding.status === "failed")
  ) {
    return "check-delivery";
  }
  switch (binding.status) {
    case "connected":
      // A connected binding with a failure means a later attempt or reply failed while the
      // running transport stayed up. Offer the repair for that failure.
      switch (binding.failureCategory) {
        case "credentials":
          return "update-credentials";
        case "network":
        case "restore":
          return "reconnect";
        default:
          return "none";
      }
    case "disconnected":
      return "connect";
    case "needs-reconnect":
      return "reconnect";
    case "failed":
      return binding.failureCategory === "credentials" ? "update-credentials" : "reconnect";
  }
}

export function channelRepairLabel(action: ChannelRepairAction): string | null {
  switch (action) {
    case "none":
      return null;
    case "wait":
      return "Connecting…";
    case "connect":
      return "Connect";
    case "reconnect":
      return "Reconnect";
    case "update-credentials":
      return "Update credentials";
    case "choose-project":
      return "Choose project";
    case "check-delivery":
      return "Check the channel";
    case "configure-public-url":
      return "Set a public URL";
  }
}

export function channelBindingPresentation(
  binding: ChannelBinding,
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>,
) {
  const deliveredCount = new Set(binding.sentMessageIds).size;
  const needsProject = channelBindingNeedsProject(binding, projects);
  return {
    provider: channelProviderLabel(binding.provider),
    health: channelHealthLabel(binding.status),
    needsProjectConfirmation: needsProject,
    warning: needsProject
      ? "Choose a project before reconnecting"
      : binding.lastError
        ? "Channel needs attention"
        : null,
    project: binding.projectId
      ? (projects.find((project) => project.id === binding.projectId)?.title ??
        "Project unavailable")
      : "No project selected",
    delivery:
      deliveredCount === 0
        ? "No confirmed deliveries"
        : `${deliveredCount} confirmed ${deliveredCount === 1 ? "delivery" : "deliveries"}`,
  };
}

/** Where a failed reassignment puts the channel back: its old project while live, else the attempted one. */
export function channelRestoreProjectId(
  previousProjectId: ProjectId | undefined,
  attemptedProjectId: ProjectId,
  liveProjects: ReadonlyArray<ProjectRef>,
): ProjectId {
  return previousProjectId && liveProjects.some((project) => project.id === previousProjectId)
    ? previousProjectId
    : attemptedProjectId;
}

/** A binding needs a new project when the server blocked it or its project is no longer live. */
export function channelBindingNeedsProject(
  binding: Pick<ChannelBinding, "status" | "projectId">,
  liveProjects: ReadonlyArray<ProjectRef>,
): boolean {
  return (
    binding.status === "blocked" ||
    !binding.projectId ||
    !liveProjects.some((project) => project.id === binding.projectId)
  );
}

/**
 * The project a channel picker shows. An explicit choice wins, then the binding's own live project,
 * then the hint (usually `defaultProjectIdForBot`). Returns null when no live project applies, so
 * callers keep attach and repair disabled until the user picks one.
 */
export function channelPickerProjectId(input: {
  readonly selected: ProjectId | null | undefined;
  readonly binding: Pick<ChannelBinding, "status" | "projectId"> | undefined;
  readonly hint: ProjectId | null;
  readonly liveProjects: ReadonlyArray<ProjectRef>;
}): ProjectId | null {
  const live = (id: ProjectId | null | undefined): id is ProjectId =>
    !!id && input.liveProjects.some((project) => project.id === id);
  if (live(input.selected)) return input.selected;
  if (input.binding && !channelBindingNeedsProject(input.binding, input.liveProjects)) {
    return input.binding.projectId ?? null;
  }
  return live(input.hint) ? input.hint : null;
}

/** Whether the picked project differs from where the binding runs, or repairs a blocked binding. */
export function canChangeChannelProject(
  binding: Pick<ChannelBinding, "status" | "projectId">,
  pickedProjectId: ProjectId | null,
  liveProjects: ReadonlyArray<ProjectRef>,
): pickedProjectId is ProjectId {
  if (!pickedProjectId || !liveProjects.some((project) => project.id === pickedProjectId)) {
    return false;
  }
  return channelBindingNeedsProject(binding, liveProjects) || pickedProjectId !== binding.projectId;
}

export function channelOriginLabel(
  origin: ChannelMessageOrigin,
  senderDisplayName?: string | null,
): string {
  const sender = senderDisplayName?.trim() || origin.externalSenderId;
  const provider = channelProviderLabel(origin.provider);
  return sender ? `${provider} · ${sender}` : provider;
}
