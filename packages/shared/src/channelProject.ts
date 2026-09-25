import type { BotId, ProjectId } from "@t3tools/contracts";

/** Accepts both the server read model and the client shell snapshot, which only lists live projects. */
export interface ChannelProjectModel {
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly updatedAt: string;
    readonly deletedAt?: string | null | undefined;
  }>;
  readonly threads: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly botId?: BotId | null | undefined;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
  }>;
}

/**
 * Preselects the project shown by channel clients. The server never uses this to attach a channel.
 */
export function defaultProjectIdForBot(
  model: ChannelProjectModel,
  botId: BotId | null,
): ProjectId | null {
  const live = model.projects.filter((project) => project.deletedAt == null);
  if (live.length === 0) return null;
  const latestActivity = new Map<ProjectId, string>();
  for (const thread of model.threads) {
    if (thread.archivedAt !== null) continue;
    const previous = latestActivity.get(thread.projectId);
    if (!previous || thread.updatedAt > previous)
      latestActivity.set(thread.projectId, thread.updatedAt);
  }
  const botThreads = model.threads.filter(
    (thread) => botId !== null && thread.botId === botId && thread.archivedAt === null,
  );
  const botProject = botThreads
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => live.find((project) => project.id === thread.projectId))
    .find((project) => project !== undefined);
  if (botProject) return botProject.id;
  return live.toSorted(
    (left, right) =>
      (latestActivity.get(right.id) ?? right.updatedAt).localeCompare(
        latestActivity.get(left.id) ?? left.updatedAt,
      ) || left.title.localeCompare(right.title),
  )[0]!.id;
}
