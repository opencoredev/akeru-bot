import { PortabilityArchive, ProjectId, type PortabilityProjectFolderMap, type PortabilityProjectData, type OrchestrationReadModel } from "@akeru/contracts";
import { isWindowsAbsolutePath, normalizeProjectPathForComparison, normalizeProjectPathForDispatch } from "@akeru/shared/path";

import { portableProjectData } from "./portabilitySafety.ts";
import { portableId } from "./portabilityArchive.ts";

export type ProjectRestoreMatch =
  | { readonly kind: "matched"; readonly targetId: ProjectId }
  | { readonly kind: "created"; readonly targetId: ProjectId; readonly workspaceRoot: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "unsupported"; readonly reason: string };

export function normalizedIdentityPart(value: string | undefined): string | undefined {
  return value?.trim().toLocaleLowerCase("en-US");
}

export function repositoriesMatch(
  source: PortabilityProjectData["repository"],
  target: PortabilityProjectData["repository"],
): boolean {
  if (!source || !target) return false;
  const sourceProvider = normalizedIdentityPart(source.provider);
  const targetProvider = normalizedIdentityPart(target.provider);
  if (sourceProvider !== targetProvider) return false;
  const sourceOwner = normalizedIdentityPart(source.owner);
  const targetOwner = normalizedIdentityPart(target.owner);
  const sourceName = normalizedIdentityPart(source.name);
  const targetName = normalizedIdentityPart(target.name);
  if (sourceOwner && targetOwner && sourceName && targetName) {
    return sourceOwner === targetOwner && sourceName === targetName;
  }
  const sourceDisplayName = normalizedIdentityPart(source.displayName);
  const targetDisplayName = normalizedIdentityPart(target.displayName);
  return sourceDisplayName !== undefined && sourceDisplayName === targetDisplayName;
}

export function resolveExistingProjectRestoreMatches(
  archive: PortabilityArchive,
  snapshot: OrchestrationReadModel,
): Map<string, ProjectRestoreMatch> {
  const sourceProjects = archive.records.filter((record) => record.type === "project");
  const targets = snapshot.projects
    .filter((project) => project.deletedAt === null)
    .map((project) => ({ project, data: portableProjectData(project) }));
  const matches = new Map<string, ProjectRestoreMatch>();

  for (const source of sourceProjects) {
    const sameIdTarget = targets.find((target) => target.project.id === source.id);
    if (sameIdTarget) {
      matches.set(source.id, { kind: "matched", targetId: sameIdTarget.project.id });
      continue;
    }
    const repositoryCandidates = source.data.repository
      ? targets.filter((target) =>
          repositoriesMatch(source.data.repository, target.data.repository),
        )
      : [];
    if (repositoryCandidates.length === 1) {
      matches.set(source.id, {
        kind: "matched",
        targetId: repositoryCandidates[0]!.project.id,
      });
      continue;
    }
    if (repositoryCandidates.length > 1) {
      const workspaceCandidates = repositoryCandidates.filter(
        (target) => target.data.workspaceName === source.data.workspaceName,
      );
      if (workspaceCandidates.length === 1) {
        matches.set(source.id, {
          kind: "matched",
          targetId: workspaceCandidates[0]!.project.id,
        });
      } else {
        matches.set(source.id, {
          kind: "conflict",
        });
      }
      continue;
    }

    const workspaceCandidates = targets.filter(
      (target) =>
        target.data.workspaceName === source.data.workspaceName &&
        (source.data.repository === undefined || target.data.repository === undefined),
    );
    if (workspaceCandidates.length === 1) {
      matches.set(source.id, {
        kind: "matched",
        targetId: workspaceCandidates[0]!.project.id,
      });
    } else if (workspaceCandidates.length > 1) {
      matches.set(source.id, {
        kind: "conflict",
      });
    } else {
      matches.set(source.id, {
        kind: "unsupported",
        reason: "No existing target project matches this repository or workspace name.",
      });
    }
  }

  const sourceIdsByTarget = new Map<string, string[]>();
  for (const [sourceId, match] of matches) {
    if (match.kind !== "matched") continue;
    const sourceIds = sourceIdsByTarget.get(match.targetId) ?? [];
    sourceIds.push(sourceId);
    sourceIdsByTarget.set(match.targetId, sourceIds);
  }
  for (const [targetId, sourceIds] of sourceIdsByTarget) {
    if (sourceIds.length < 2) continue;
    const exactId = sourceIds.find((sourceId) => sourceId === targetId);
    for (const sourceId of sourceIds) {
      if (sourceId === exactId) continue;
      matches.set(sourceId, {
        kind: "conflict",
      });
    }
  }

  return matches;
}

export function normalizePortabilityProjectFolders(
  archive: PortabilityArchive,
  snapshot: OrchestrationReadModel,
  projectFolders: PortabilityProjectFolderMap = {},
): PortabilityProjectFolderMap {
  const sourceProjects = new Map(
    archive.records.flatMap((record) =>
      record.type === "project" ? [[record.id, record] as const] : [],
    ),
  );
  const existingMatches = resolveExistingProjectRestoreMatches(archive, snapshot);
  const activeWorkspaceRoots = new Set(
    snapshot.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => normalizeProjectPathForComparison(project.workspaceRoot)),
  );
  const targetWorkspaceRoots = new Map<string, string>();
  const normalized: Record<string, string> = {};

  for (const [projectId, destination] of Object.entries(projectFolders)) {
    if (!sourceProjects.has(projectId)) {
      throw new Error(`Project folder map references unknown project '${projectId}'.`);
    }
    if (existingMatches.get(projectId)?.kind !== "unsupported") {
      throw new Error(`Project '${projectId}' already has a target project.`);
    }
    if (!destination.startsWith("/") && !isWindowsAbsolutePath(destination)) {
      throw new Error(`Project '${projectId}' destination must be an absolute path.`);
    }
    const workspaceRoot = normalizeProjectPathForDispatch(destination);
    if (workspaceRoot === "/" || /^[A-Za-z]:[\\/]$/.test(workspaceRoot)) {
      throw new Error(`Project '${projectId}' destination cannot be a filesystem root.`);
    }
    const comparisonRoot = normalizeProjectPathForComparison(workspaceRoot);
    if (activeWorkspaceRoots.has(comparisonRoot)) {
      throw new Error(`Project '${projectId}' destination already belongs to an active project.`);
    }
    const otherProjectId = targetWorkspaceRoots.get(comparisonRoot);
    if (otherProjectId) {
      throw new Error(
        `Projects '${otherProjectId}' and '${projectId}' cannot use the same destination.`,
      );
    }
    targetWorkspaceRoots.set(comparisonRoot, projectId);
    normalized[projectId] = workspaceRoot;
  }

  return normalized as PortabilityProjectFolderMap;
}

export function resolveProjectRestoreMatches(
  archive: PortabilityArchive,
  snapshot: OrchestrationReadModel,
  projectFolders: PortabilityProjectFolderMap = {},
): Map<string, ProjectRestoreMatch> {
  const matches = resolveExistingProjectRestoreMatches(archive, snapshot);
  const normalizedProjectFolders = normalizePortabilityProjectFolders(
    archive,
    snapshot,
    projectFolders,
  );
  for (const [sourceId, workspaceRoot] of Object.entries(normalizedProjectFolders)) {
    let targetId = ProjectId.make(sourceId);
    let collision = 0;
    while (snapshot.projects.some((project) => project.id === targetId)) {
      targetId = ProjectId.make(portableId("project", { sourceId, workspaceRoot, collision }));
      collision += 1;
    }
    matches.set(sourceId, {
      kind: "created",
      targetId,
      workspaceRoot,
    });
  }
  return matches;
}

export function mutableProjectData(data: PortabilityProjectData) {
  return {
    title: data.title,
    defaultModelSelection: data.defaultModelSelection,
    defaultThreadEnvMode: data.defaultThreadEnvMode ?? null,
  };
}
