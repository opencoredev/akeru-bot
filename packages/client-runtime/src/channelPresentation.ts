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
