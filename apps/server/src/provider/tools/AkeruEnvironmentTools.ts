import {
  type EnvironmentHostDescriptor,
  type EnvironmentId,
  decodeAkeruToolInput,
} from "@akeru/contracts";
import {
  type EligiblePlacementReport,
  type PlacementCandidate,
  type PlacementCandidateReport,
  type PlacementRanking,
  placementCandidates,
  placementExclusionText,
} from "@akeru/shared/environmentPlacement";

import type { AkeruCatalogToolHandler } from "./AkeruCatalogTypes.ts";

export interface ListEnvironmentsDependencies {
  /** This server's own descriptor, with a fresh load reading. */
  readonly describeLocal: () => Promise<EnvironmentHostDescriptor>;
  /** The calling bot's allowed environments besides its home. */
  readonly allowedEnvironmentIds: () => Promise<ReadonlyArray<EnvironmentId>>;
  /**
   * What this server knows about other environments. A server cannot see its
   * peers yet, so the default reports none and they show as not connected.
   * Cross-environment discovery plugs in here.
   */
  readonly remoteCandidates?: (
    environmentIds: ReadonlyArray<EnvironmentId>,
  ) => Promise<ReadonlyArray<PlacementCandidate>>;
  readonly now: () => Promise<number>;
}

const rankingText = (ranking: PlacementRanking): string => {
  switch (ranking.kind) {
    case "scored":
      return `score ${Math.round(ranking.score * 100) / 100}`;
    case "unknown-load":
      return "load unknown";
    case "skipped":
      return `skipped: ${ranking.reason}`;
    default: {
      const unreachable: never = ranking;

      return unreachable;
    }
  }
};

const compactEligible = (report: EligiblePlacementReport, homeEnvironmentId: EnvironmentId) => {
  const { descriptor, ranking } = report;
  const load = descriptor.load;

  return {
    environmentId: report.environmentId,
    label: descriptor.label,
    home: report.environmentId === homeEnvironmentId,
    os: descriptor.platform.os,
    arch: descriptor.platform.arch,
    cpuCount: descriptor.cpuCount,
    cpuUtilization: load === null ? null : Math.round(load.cpuUtilization * 100) / 100,
    freeMemoryShare:
      load === null
        ? null
        : Math.round((load.availableMemoryBytes / load.totalMemoryBytes) * 100) / 100,
    tools: descriptor.tools,
    readyProviders: descriptor.providers
      .filter((provider) => provider.ready)
      .map((provider) => provider.driver),
    projects: descriptor.projects.map((project) => project.title),
    labels: descriptor.profile.labels,
    note: descriptor.profile.note,
    placementWeight: descriptor.profile.placementWeight,
    automaticPlacement: rankingText(ranking),
  };
};

const compactExcluded = (report: Extract<PlacementCandidateReport, { kind: "excluded" }>) => ({
  environmentId: report.environmentId,
  reasons: report.exclusions.map(placementExclusionText),
});

/**
 * `list_environments`: the environments the calling bot may run work on that
 * meet the requested requirements, and why every other one was left out.
 */
export function createListEnvironmentsHandler(
  deps: ListEnvironmentsDependencies,
): AkeruCatalogToolHandler {
  return async ({ input }) => {
    const { requirements } = decodeAkeruToolInput("list_environments", input);

    const [local, allowedEnvironmentIds, nowMs] = await Promise.all([
      deps.describeLocal(),
      deps.allowedEnvironmentIds(),
      deps.now(),
    ]);

    const remoteIds = allowedEnvironmentIds.filter((id) => id !== local.environmentId);
    const remote = deps.remoteCandidates ? await deps.remoteCandidates(remoteIds) : [];

    const reports = placementCandidates({
      nowMs,
      homeEnvironmentId: local.environmentId,
      allowedEnvironmentIds,
      // The local descriptor was received just now, on this server's own clock.
      candidates: [{ kind: "online", descriptor: local, receivedAtMs: nowMs }, ...remote],
      ...(requirements ? { requirements } : {}),
    });

    return {
      eligible: reports.flatMap((report) =>
        report.kind === "eligible" ? [compactEligible(report, local.environmentId)] : [],
      ),
      excluded: reports.flatMap((report) =>
        report.kind === "excluded" ? [compactExcluded(report)] : [],
      ),
      ...(deps.remoteCandidates === undefined && remoteIds.length > 0
        ? {
            visibility:
              "Only this environment is visible from here. Other allowed environments are listed as not connected.",
          }
        : {}),
    };
  };
}
