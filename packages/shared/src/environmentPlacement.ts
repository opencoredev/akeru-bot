import type {
  EnvironmentHostDescriptor,
  EnvironmentHostLabel,
  EnvironmentHostRequirements,
  EnvironmentHostTool,
  EnvironmentId,
  EnvironmentPlacementWeight,
  ExecutionEnvironmentPlatformArch,
  ExecutionEnvironmentPlatformOs,
  ProviderDriverKind,
} from "@akeru/contracts";

/** A load reading older than this cannot be trusted for placement. */
export const PLACEMENT_LOAD_STALE_AFTER_MS = 15_000;

/** Automatic placement skips a host at or above this CPU utilization. */
export const PLACEMENT_CPU_OVERLOAD = 0.95;

/** Automatic placement skips a host at or below this share of free memory. */
export const PLACEMENT_MIN_FREE_MEMORY_SHARE = 0.05;

export const PLACEMENT_WEIGHT_FACTORS = {
  prefer: 2,
  normal: 1,
  "less-often": 0.5,
  "manual-only": 0,
} as const satisfies Record<EnvironmentPlacementWeight, number>;

type NonEmpty<T> = readonly [T, ...T[]];

/** What a client knows about one environment when it asks for a placement. */
export type PlacementCandidate =
  | {
      readonly kind: "online";
      readonly descriptor: EnvironmentHostDescriptor;
      /**
       * When the caller received the descriptor, on the caller's clock (the
       * same clock as `PlacementInput.nowMs`). Never the server's clock.
       */
      readonly receivedAtMs: number;
    }
  | { readonly kind: "offline"; readonly environmentId: EnvironmentId }
  /** Connected, but its descriptor has not loaded yet. */
  | { readonly kind: "undescribed"; readonly environmentId: EnvironmentId };

export interface PlacementInput {
  /** The caller's current time, on the same clock as every `receivedAtMs`. */
  readonly nowMs: number;
  /** The environment that owns the bot. Always allowed. */
  readonly homeEnvironmentId: EnvironmentId;
  /** The bot's other allowed environments (`OrchestrationBot.allowedEnvironmentIds`). */
  readonly allowedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly candidates: ReadonlyArray<PlacementCandidate>;
  readonly requirements?: EnvironmentHostRequirements;
  /** The bot's provider driver. When set, the environment must have a ready instance of it. */
  readonly provider?: ProviderDriverKind;
  /** An explicit choice by the user. It must be eligible; it never overrides eligibility. */
  readonly userChoice?: EnvironmentId;
  /** The bot's own pick. Used when eligible and not manual-only, otherwise ignored. */
  readonly botChoice?: EnvironmentId;
}

export type PlacementExclusion =
  | { readonly reason: "unknown-environment" }
  | { readonly reason: "not-allowed" }
  | { readonly reason: "offline" }
  | { readonly reason: "no-descriptor" }
  | { readonly reason: "stale-load"; readonly ageMs: number }
  | {
      readonly reason: "os-mismatch";
      readonly required: ExecutionEnvironmentPlatformOs;
      readonly actual: ExecutionEnvironmentPlatformOs;
    }
  | {
      readonly reason: "arch-mismatch";
      readonly required: ExecutionEnvironmentPlatformArch;
      readonly actual: ExecutionEnvironmentPlatformArch;
    }
  | { readonly reason: "missing-tools"; readonly tools: NonEmpty<EnvironmentHostTool> }
  | { readonly reason: "missing-labels"; readonly labels: NonEmpty<EnvironmentHostLabel> }
  | { readonly reason: "missing-project"; readonly project: string }
  | { readonly reason: "provider-not-ready"; readonly provider: ProviderDriverKind };

/** How an eligible environment fares in automatic placement. */
export type PlacementRanking =
  | { readonly kind: "scored"; readonly score: number }
  /** No load reading. Picked only when no host with known load qualifies. */
  | { readonly kind: "unknown-load" }
  | { readonly kind: "skipped"; readonly reason: "manual-only" | "cpu-overloaded" | "memory-low" };

export type PlacementCandidateReport =
  | {
      readonly kind: "excluded";
      readonly environmentId: EnvironmentId;
      readonly exclusions: NonEmpty<PlacementExclusion>;
    }
  | {
      readonly kind: "eligible";
      readonly environmentId: EnvironmentId;
      readonly descriptor: EnvironmentHostDescriptor;
      readonly ranking: PlacementRanking;
    };

export type EligiblePlacementReport = Extract<PlacementCandidateReport, { kind: "eligible" }>;

export type PlacementResult =
  | {
      readonly kind: "placed";
      readonly environmentId: EnvironmentId;
      readonly via: "user-choice" | "bot-choice" | "score" | "unknown-load";
      /** Set when the bot picked an environment that placement could not use. */
      readonly rejectedBotChoice: EnvironmentId | null;
      readonly candidates: ReadonlyArray<PlacementCandidateReport>;
    }
  | {
      /** The user picked an environment outside the eligible set. Nothing was placed. */
      readonly kind: "choice-ineligible";
      readonly environmentId: EnvironmentId;
      readonly exclusions: NonEmpty<PlacementExclusion>;
      readonly candidates: ReadonlyArray<PlacementCandidateReport>;
    }
  | {
      /** Nothing qualifies for automatic placement. `candidates` says why. */
      readonly kind: "unplaced";
      readonly rejectedBotChoice: EnvironmentId | null;
      readonly candidates: ReadonlyArray<PlacementCandidateReport>;
    };

const candidateEnvironmentId = (candidate: PlacementCandidate): EnvironmentId =>
  candidate.kind === "online" ? candidate.descriptor.environmentId : candidate.environmentId;

const lastPathSegment = (path: string): string => {
  const segments = path.split(/[\\/]/u).filter((segment) => segment.length > 0);

  return segments[segments.length - 1] ?? path;
};

const hasProject = (descriptor: EnvironmentHostDescriptor, project: string): boolean => {
  const wanted = project.toLowerCase();

  return descriptor.projects.some(
    (candidate) =>
      candidate.title.toLowerCase() === wanted ||
      lastPathSegment(candidate.workspaceRoot).toLowerCase() === wanted,
  );
};

const nonEmpty = <T>(values: ReadonlyArray<T>): NonEmpty<T> | null => {
  const [first, ...rest] = values;

  return first === undefined ? null : [first, ...rest];
};

/**
 * How old a load reading is now. The server's `sampleAgeMs` is a duration on
 * its clock, and the time since receipt is a duration on the caller's clock,
 * so the two add without comparing clocks from different machines. A receipt
 * time in the caller's future counts as zero rather than making the reading
 * younger than the server said.
 */
export function placementLoadAgeMs(input: {
  readonly sampleAgeMs: number;
  readonly receivedAtMs: number;
  readonly nowMs: number;
}): number {
  return input.sampleAgeMs + Math.max(0, input.nowMs - input.receivedAtMs);
}

/** Every hard requirement the descriptor fails, in a stable order. */
function descriptorExclusions(
  candidate: Extract<PlacementCandidate, { kind: "online" }>,
  input: PlacementInput,
): ReadonlyArray<PlacementExclusion> {
  const { descriptor } = candidate;
  const exclusions: PlacementExclusion[] = [];
  const requirements = input.requirements ?? {};

  if (descriptor.load !== null) {
    const ageMs = placementLoadAgeMs({
      sampleAgeMs: descriptor.load.sampleAgeMs,
      receivedAtMs: candidate.receivedAtMs,
      nowMs: input.nowMs,
    });

    if (!(ageMs <= PLACEMENT_LOAD_STALE_AFTER_MS)) exclusions.push({ reason: "stale-load", ageMs });
  }

  if (requirements.os !== undefined && requirements.os !== descriptor.platform.os) {
    exclusions.push({
      reason: "os-mismatch",
      required: requirements.os,
      actual: descriptor.platform.os,
    });
  }

  if (requirements.arch !== undefined && requirements.arch !== descriptor.platform.arch) {
    exclusions.push({
      reason: "arch-mismatch",
      required: requirements.arch,
      actual: descriptor.platform.arch,
    });
  }

  const missingTools = nonEmpty(
    (requirements.tools ?? []).filter((tool) => !descriptor.tools.includes(tool)),
  );

  if (missingTools) exclusions.push({ reason: "missing-tools", tools: missingTools });

  const ownLabels = new Set(descriptor.profile.labels.map((label) => label.toLowerCase()));

  const missingLabels = nonEmpty(
    (requirements.labels ?? []).filter((label) => !ownLabels.has(label.toLowerCase())),
  );

  if (missingLabels) exclusions.push({ reason: "missing-labels", labels: missingLabels });

  if (requirements.project !== undefined && !hasProject(descriptor, requirements.project)) {
    exclusions.push({ reason: "missing-project", project: requirements.project });
  }

  if (
    input.provider !== undefined &&
    !descriptor.providers.some((provider) => provider.driver === input.provider && provider.ready)
  ) {
    exclusions.push({ reason: "provider-not-ready", provider: input.provider });
  }

  return exclusions;
}

/** Placement score: weight × cpuCount × idle CPU share × free memory share. */
export function placementScore(descriptor: EnvironmentHostDescriptor): PlacementRanking {
  const weight = PLACEMENT_WEIGHT_FACTORS[descriptor.profile.placementWeight];

  if (weight === 0) return { kind: "skipped", reason: "manual-only" };

  const load = descriptor.load;

  if (load === null) return { kind: "unknown-load" };

  if (load.cpuUtilization >= PLACEMENT_CPU_OVERLOAD) {
    return { kind: "skipped", reason: "cpu-overloaded" };
  }

  const freeMemoryShare = load.availableMemoryBytes / load.totalMemoryBytes;

  if (freeMemoryShare <= PLACEMENT_MIN_FREE_MEMORY_SHARE) {
    return { kind: "skipped", reason: "memory-low" };
  }

  return {
    kind: "scored",
    score: weight * descriptor.cpuCount * (1 - load.cpuUtilization) * freeMemoryShare,
  };
}

function reportCandidate(
  candidate: PlacementCandidate,
  allowed: ReadonlySet<EnvironmentId>,
  input: PlacementInput,
): PlacementCandidateReport {
  const environmentId = candidateEnvironmentId(candidate);

  const notAllowed: ReadonlyArray<PlacementExclusion> = allowed.has(environmentId)
    ? []
    : [{ reason: "not-allowed" }];

  if (candidate.kind === "offline" || candidate.kind === "undescribed") {
    return {
      kind: "excluded",
      environmentId,
      exclusions: [
        { reason: candidate.kind === "offline" ? "offline" : "no-descriptor" },
        ...notAllowed,
      ],
    };
  }

  const exclusions = nonEmpty([...notAllowed, ...descriptorExclusions(candidate, input)]);

  if (exclusions !== null) return { kind: "excluded", environmentId, exclusions };

  return {
    kind: "eligible",
    environmentId,
    descriptor: candidate.descriptor,
    ranking: placementScore(candidate.descriptor),
  };
}

/**
 * Builds the bot's eligible environments and every exclusion reason, without
 * choosing. Allowed environments the caller has no record of are reported as
 * offline.
 */
export function placementCandidates(
  input: PlacementInput,
): ReadonlyArray<PlacementCandidateReport> {
  const allowed = new Set<EnvironmentId>([input.homeEnvironmentId, ...input.allowedEnvironmentIds]);
  const seen = new Set<EnvironmentId>();
  const reports: PlacementCandidateReport[] = [];

  for (const candidate of input.candidates) {
    const environmentId = candidateEnvironmentId(candidate);

    if (seen.has(environmentId)) continue;
    seen.add(environmentId);
    reports.push(reportCandidate(candidate, allowed, input));
  }

  for (const environmentId of allowed) {
    if (seen.has(environmentId)) continue;
    seen.add(environmentId);
    reports.push({ kind: "excluded", environmentId, exclusions: [{ reason: "offline" }] });
  }

  return reports;
}

/** Home first, then environment id, so equal candidates always resolve the same way. */
const tieBreak =
  (homeEnvironmentId: EnvironmentId) =>
  (left: EligiblePlacementReport, right: EligiblePlacementReport): number => {
    if (left.environmentId === homeEnvironmentId) return -1;

    if (right.environmentId === homeEnvironmentId) return 1;

    return left.environmentId < right.environmentId ? -1 : 1;
  };

const scoreOf = (report: EligiblePlacementReport): number =>
  report.ranking.kind === "scored" ? report.ranking.score : 0;

const weightOf = (report: EligiblePlacementReport): number =>
  PLACEMENT_WEIGHT_FACTORS[report.descriptor.profile.placementWeight];

export const isEligiblePlacement = (
  report: PlacementCandidateReport,
): report is EligiblePlacementReport => report.kind === "eligible";

/**
 * Chooses where work runs. An explicit user choice wins when it is eligible
 * and is an error otherwise. Then the bot's choice, when eligible and not
 * manual-only. Then the highest score among hosts with fresh load, then the
 * heaviest-weighted host with unknown load.
 */
export function placeWork(input: PlacementInput): PlacementResult {
  const candidates = placementCandidates(input);
  const eligible = candidates.filter(isEligiblePlacement);

  if (input.userChoice !== undefined) {
    const chosen = candidates.find((report) => report.environmentId === input.userChoice);

    if (chosen?.kind === "eligible") {
      return {
        kind: "placed",
        environmentId: chosen.environmentId,
        via: "user-choice",
        rejectedBotChoice: null,
        candidates,
      };
    }

    return {
      kind: "choice-ineligible",
      environmentId: input.userChoice,
      exclusions: chosen?.exclusions ?? [{ reason: "unknown-environment" }],
      candidates,
    };
  }

  let rejectedBotChoice: EnvironmentId | null = null;

  if (input.botChoice !== undefined) {
    const chosen = eligible.find((report) => report.environmentId === input.botChoice);

    if (chosen !== undefined && weightOf(chosen) > 0) {
      return {
        kind: "placed",
        environmentId: chosen.environmentId,
        via: "bot-choice",
        rejectedBotChoice: null,
        candidates,
      };
    }

    rejectedBotChoice = input.botChoice;
  }

  const breakTie = tieBreak(input.homeEnvironmentId);

  // .sort() on a filtered copy, not .toSorted(): Hermes lacks ES2023 change-by-copy.
  const [best] = eligible
    .filter((report) => report.ranking.kind === "scored")
    .sort((left, right) => scoreOf(right) - scoreOf(left) || breakTie(left, right));

  if (best !== undefined) {
    return {
      kind: "placed",
      environmentId: best.environmentId,
      via: "score",
      rejectedBotChoice,
      candidates,
    };
  }

  const [fallback] = eligible
    .filter((report) => report.ranking.kind === "unknown-load")
    .sort((left, right) => weightOf(right) - weightOf(left) || breakTie(left, right));

  if (fallback !== undefined) {
    return {
      kind: "placed",
      environmentId: fallback.environmentId,
      via: "unknown-load",
      rejectedBotChoice,
      candidates,
    };
  }

  return { kind: "unplaced", rejectedBotChoice, candidates };
}

/** One short English sentence per exclusion, for bots and logs. */
export function placementExclusionText(exclusion: PlacementExclusion): string {
  switch (exclusion.reason) {
    case "unknown-environment":
      return "No environment with this id is known.";
    case "not-allowed":
      return "This bot is not allowed to run work here.";
    case "offline":
      return "The environment is not connected.";
    case "no-descriptor":
      return "The environment has not described itself yet.";
    case "stale-load":
      return `Its load reading is ${Math.round(exclusion.ageMs / 1000)}s old.`;
    case "os-mismatch":
      return `Needs ${exclusion.required}, but it runs ${exclusion.actual}.`;
    case "arch-mismatch":
      return `Needs ${exclusion.required}, but it is ${exclusion.actual}.`;
    case "missing-tools":
      return `Missing ${exclusion.tools.join(", ")}.`;
    case "missing-labels":
      return `Not labeled ${exclusion.labels.join(", ")}.`;
    case "missing-project":
      return `Has no project named ${exclusion.project}.`;
    case "provider-not-ready":
      return `The ${exclusion.provider} provider is not ready there.`;
    default: {
      const unreachable: never = exclusion;

      return unreachable;
    }
  }
}
