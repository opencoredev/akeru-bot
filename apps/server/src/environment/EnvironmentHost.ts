import * as NodeOS from "node:os";
import {
  type EnvironmentHostDescriptor,
  type EnvironmentHostLoad,
  type EnvironmentHostProfile,
  type EnvironmentHostProject,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
  isProviderAvailable,
} from "@akeru/contracts";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ServerConfig } from "../config.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { preflightProvider } from "../provider/providerPreflight.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SubscriptionAuthService } from "../subscription-auth/service.ts";
import { cgroupMemoryLimit } from "./EnvironmentHostMemory.ts";
import { detectEnvironmentHostTools, splitSearchPath } from "./EnvironmentHostTools.ts";
import { ServerEnvironment } from "./ServerEnvironment.ts";

/**
 * Cumulative CPU time over the CPUs this process may use. `cpuSet` names that set, so two readings
 * over different sets are never compared.
 */
export interface CpuTimes {
  readonly idleMs: number;
  readonly totalMs: number;
  readonly cpuSet?: string;
}

/**
 * The machine readings the descriptor needs. Every call is an in-process read
 * (`node:os`, file existence); nothing here starts a subprocess.
 */
export interface EnvironmentHostMachine {
  readonly cpuCount: () => number;
  readonly cpuTimes: () => Effect.Effect<CpuTimes>;
  readonly memory: () => Effect.Effect<{
    readonly availableBytes: number;
    readonly totalBytes: number;
  }>;
  /** The raw PATH value. Read on each tool check so a repaired PATH is picked up. */
  readonly searchPath: () => string | undefined;
  /** The raw `DEVELOPER_DIR` value, which selects an Xcode on macOS. */
  readonly developerDirectory: () => string | undefined;
  readonly exists: (path: string) => Effect.Effect<boolean>;
}

/**
 * Live account and request health, the inputs turn preflight reads besides the
 * provider snapshot. A usage cap or rate limit shows up here, not in the snapshot.
 */
export type ProviderTurnHealth = Pick<
  Parameters<typeof preflightProvider>[0],
  "subscriptionStatusForInstance" | "subscriptionHealth"
>;

export interface EnvironmentHostOptions {
  /** How long to wait between two CPU readings when there is no recent one. */
  readonly sampleWindow: Duration.Duration;
  /** How long detected tools are reused before the paths are checked again. */
  readonly toolsTimeToLive: Duration.Duration;
  /** Live provider health. Without it, readiness comes from the provider snapshot alone. */
  readonly providerHealth?: ProviderTurnHealth;
}

const DEFAULT_OPTIONS: EnvironmentHostOptions = {
  sampleWindow: Duration.millis(250),
  toolsTimeToLive: Duration.minutes(10),
};

/** A reading this recent is returned as-is, so a burst of describes costs one sample. */
const LOAD_REUSE_MS = 1_000;

/** A previous CPU reading older than this no longer describes current load. */
const LOAD_BASELINE_MAX_AGE_MS = 10_000;

/**
 * The profile published when settings have never been readable. The owner's
 * choice is unknown, so the host describes nothing and stays out of automatic
 * placement rather than claiming the `normal` default.
 */
const UNREAD_PROFILE: EnvironmentHostProfile = {
  labels: [],
  note: "",
  placementWeight: "manual-only",
};

export class EnvironmentHost extends Context.Service<
  EnvironmentHost,
  {
    /** This environment's machine, tools, providers, projects, and owner profile. */
    readonly describe: Effect.Effect<EnvironmentHostDescriptor>;
  }
>()("akeru-bot/environment/EnvironmentHost") {}

/**
 * Busy share of CPU time between two readings, or `null` when no time passed or the allowed CPUs
 * changed between them.
 */
export function cpuUtilizationBetween(previous: CpuTimes, next: CpuTimes): number | null {
  if (previous.cpuSet !== next.cpuSet) return null;
  const total = next.totalMs - previous.totalMs;
  const idle = next.idleMs - previous.idleMs;

  if (!(total > 0)) return null;

  return Math.min(1, Math.max(0, 1 - idle / total));
}

/**
 * Whether a new turn could start on this provider now. It runs the same
 * preflight a turn start does, so a usage cap or an active rate limit makes the
 * provider not ready until its retry time passes.
 */
export function isProviderReady(input: {
  readonly provider: ServerProvider;
  readonly providerInstanceConfig?: ProviderInstanceConfig | undefined;
  readonly health?: ProviderTurnHealth | undefined;
  readonly now: number;
}): boolean {
  const { provider } = input;

  if (
    !provider.enabled ||
    !provider.installed ||
    !isProviderAvailable(provider) ||
    provider.unavailability !== undefined ||
    (provider.status !== "ready" && provider.status !== "warning") ||
    provider.auth.status === "unauthenticated"
  ) {
    return false;
  }

  // No model is chosen here, so a verdict about one model does not make the
  // provider unready. Every other verdict blocks the next turn outright.
  const verdict = preflightProvider({
    providers: [provider],
    providerId: provider.instanceId,
    model: "",
    ...(input.providerInstanceConfig
      ? { providerInstanceConfig: input.providerInstanceConfig }
      : {}),
    ...input.health,
    now: input.now,
  });

  return verdict === undefined || verdict.category === "unsupported-model";
}

/** A load reading stamped with this server's clock. The age is computed when the descriptor is sent. */
interface LoadReading extends Omit<EnvironmentHostLoad, "sampleAgeMs"> {
  readonly sampledMs: number;
}

interface LoadBaseline {
  readonly times: CpuTimes;
  readonly atMs: number;
  readonly load: LoadReading | null;
}

export const make = (
  machine: EnvironmentHostMachine,
  options: Partial<EnvironmentHostOptions> = {},
) =>
  Effect.gen(function* () {
    const { sampleWindow, toolsTimeToLive, providerHealth } = { ...DEFAULT_OPTIONS, ...options };
    const serverEnvironment = yield* ServerEnvironment;
    const serverSettings = yield* ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry;
    const projects = yield* ProjectionProjectRepository;
    const environment = yield* serverEnvironment.getDescriptor;
    const baseline = yield* Ref.make<LoadBaseline | null>(null);
    const lastSettings = yield* Ref.make<ServerSettings | null>(null);

    const tools = yield* Effect.cachedWithTTL(
      Effect.suspend(() =>
        detectEnvironmentHostTools({
          os: environment.platform.os,
          searchPath: splitSearchPath(machine.searchPath(), environment.platform.os),
          developerDirectory: machine.developerDirectory(),
          exists: machine.exists,
        }),
      ),
      toolsTimeToLive,
    );

    const sampleLoad = Effect.gen(function* () {
      const startedMs = yield* Clock.currentTimeMillis;
      const previous = yield* Ref.get(baseline);

      if (
        previous !== null &&
        previous.load !== null &&
        startedMs - previous.atMs < LOAD_REUSE_MS
      ) {
        return previous.load;
      }

      let base = previous;

      if (base === null || startedMs - base.atMs > LOAD_BASELINE_MAX_AGE_MS) {
        base = { times: yield* machine.cpuTimes(), atMs: startedMs, load: null };

        if (Duration.isGreaterThan(sampleWindow, Duration.zero)) yield* Effect.sleep(sampleWindow);
      }

      const sampledMs = yield* Clock.currentTimeMillis;
      const times = yield* machine.cpuTimes();
      const cpuUtilization = cpuUtilizationBetween(base.times, times);
      const memory = yield* machine.memory();

      const load: LoadReading | null =
        cpuUtilization === null || !(memory.totalBytes > 0)
          ? null
          : {
              cpuUtilization,
              availableMemoryBytes: Math.max(0, Math.floor(memory.availableBytes)),
              totalMemoryBytes: Math.floor(memory.totalBytes),
              sampledMs,
            };

      yield* Ref.set(baseline, { times, atMs: sampledMs, load });

      return load;
    });

    const listProjects = projects.listAll().pipe(
      Effect.map((rows) =>
        rows.flatMap((row): ReadonlyArray<EnvironmentHostProject> => {
          const title = row.title.trim();
          const workspaceRoot = row.workspaceRoot.trim();

          return row.deletedAt === null && title.length > 0 && workspaceRoot.length > 0
            ? [{ projectId: row.projectId, title, workspaceRoot }]
            : [];
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("environment host could not list projects", { error }).pipe(
          Effect.as<ReadonlyArray<EnvironmentHostProject>>([]),
        ),
      ),
    );

    // A failed read keeps the last good settings, so the owner's weight is not
    // silently reset to the default. `null` means settings were never readable.
    const readSettings = serverSettings.getSettings.pipe(
      Effect.tap((settings) => Ref.set(lastSettings, settings)),
      Effect.catch((error) =>
        Effect.logWarning("environment host could not read settings", { error }).pipe(
          Effect.andThen(Ref.get(lastSettings)),
        ),
      ),
    );

    const describe = Effect.gen(function* () {
      const [detectedTools, load, providers, projectList, settings] = yield* Effect.all(
        [tools, sampleLoad, providerRegistry.getProviders, listProjects, readSettings],
        { concurrency: "unbounded" },
      );

      // Age the reading as late as possible, right before it leaves this server.
      const sentMs = yield* Clock.currentTimeMillis;
      const providerConfigs = settings === null ? {} : deriveProviderInstanceConfigMap(settings);

      return {
        environmentId: environment.environmentId,
        label: environment.label,
        platform: environment.platform,
        cpuCount: Math.max(1, machine.cpuCount()),
        load:
          load === null
            ? null
            : {
                cpuUtilization: load.cpuUtilization,
                availableMemoryBytes: load.availableMemoryBytes,
                totalMemoryBytes: load.totalMemoryBytes,
                sampleAgeMs: Math.max(0, Math.round(sentMs - load.sampledMs)),
              },
        tools: detectedTools,
        providers: providers.map((provider) => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          ready: isProviderReady({
            provider,
            providerInstanceConfig: providerConfigs[provider.instanceId],
            health: providerHealth,
            now: sentMs,
          }),
        })),
        projects: projectList,
        profile: settings?.environmentHost ?? UNREAD_PROFILE,
      } satisfies EnvironmentHostDescriptor;
    });

    return EnvironmentHost.of({ describe });
  });

/**
 * The CPU ids this process may run on, from `Cpus_allowed_list` in `/proc/self/status`, such as
 * `0-3,8`. `undefined` when the list is missing or unreadable, which means every CPU.
 */
export const allowedCpuIds = (status: string): ReadonlySet<number> | undefined => {
  const list = /^Cpus_allowed_list:\s*(\S+)\s*$/m.exec(status)?.[1];

  if (list === undefined) return undefined;
  const ids = new Set<number>();

  for (const range of list.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(range);

    if (match?.[1] === undefined) return undefined;
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);

    if (last < first) return undefined;

    for (let id = first; id <= last; id += 1) ids.add(id);
  }

  return ids.size > 0 ? ids : undefined;
};

/**
 * CPU time from `/proc/stat`, summed over the `cpuN` lines whose id is allowed. The ids come from
 * the file itself, because `os.cpus()` packs online CPUs densely and its positions are not ids.
 * Idle counts iowait; the total runs from user through steal. `undefined` when no line matches.
 */
export const procStatCpuTimes = (
  stat: string,
  allowed: ReadonlySet<number> | undefined,
): Omit<CpuTimes, "cpuSet"> | undefined => {
  let idleMs = 0;
  let totalMs = 0;
  let matched = false;

  for (const match of stat.matchAll(/^cpu(\d+)((?:\s+\d+){4,})/gm)) {
    if (allowed !== undefined && !allowed.has(Number(match[1]))) continue;
    const fields = (match[2] ?? "").trim().split(/\s+/).map(Number);

    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
      fields;

    idleMs += idle + iowait;
    totalMs += user + nice + system + idle + iowait + irq + softirq + steal;
    matched = true;
  }

  return matched ? { idleMs, totalMs } : undefined;
};

/** CPU time across every CPU `os.cpus()` reports, for platforms without `/proc`. */
const osCpuTimes = (): CpuTimes => {
  let idleMs = 0;
  let totalMs = 0;

  for (const cpu of NodeOS.cpus()) {
    idleMs += cpu.times.idle;
    totalMs += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  return { idleMs, totalMs };
};

/**
 * CPU time over the CPUs this process may use, matching `availableParallelism()`. Linux reads the
 * affinity on every sample, since `taskset` or a cpuset update can change it while the server runs.
 */
const processCpuTimes = (fileSystem: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) !== "linux") return osCpuTimes();

    const read = (path: string) =>
      fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

    const [status, stat] = yield* Effect.all([read("/proc/self/status"), read("/proc/stat")]);
    const allowed = allowedCpuIds(status);
    const times = procStatCpuTimes(stat, allowed);

    if (times === undefined) return osCpuTimes();

    return { ...times, cpuSet: allowed === undefined ? "all" : [...allowed].join(",") };
  });

/**
 * `MemAvailable` from `/proc/meminfo`, in bytes. Linux's `os.freemem()` is MemFree, which leaves
 * out reclaimable page cache, so a healthy busy host would look almost out of memory.
 */
export const memAvailableBytes = (meminfo: string): number | undefined => {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);

  return match?.[1] === undefined ? undefined : Number(match[1]) * 1024;
};

/**
 * Free and total memory for this process. On Linux a cgroup limit, such as a
 * Docker `--memory` limit, caps both: the host can have plenty free while the
 * container is nearly full.
 */
export const linuxMemory = (fileSystem: FileSystem.FileSystem, totalBytes: number) =>
  Effect.gen(function* () {
    const meminfo = yield* fileSystem
      .readFileString("/proc/meminfo")
      .pipe(Effect.orElseSucceed(() => ""));

    const hostAvailableBytes = memAvailableBytes(meminfo) ?? NodeOS.freemem();
    const limit = yield* cgroupMemoryLimit(fileSystem, totalBytes);

    if (limit === undefined) return { availableBytes: hostAvailableBytes, totalBytes };

    return {
      availableBytes: Math.min(hostAvailableBytes, Math.max(0, limit.limitBytes - limit.usedBytes)),
      totalBytes: limit.limitBytes,
    };
  });

const processMemory = (fileSystem: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    const totalBytes = NodeOS.totalmem();

    if ((yield* HostProcessPlatform) !== "linux") {
      return { availableBytes: NodeOS.freemem(), totalBytes };
    }

    return yield* linuxMemory(fileSystem, totalBytes);
  });

export const nodeMachine = (fileSystem: FileSystem.FileSystem): EnvironmentHostMachine => ({
  cpuCount: () => NodeOS.availableParallelism(),
  cpuTimes: () => processCpuTimes(fileSystem),
  memory: () => processMemory(fileSystem),
  searchPath: () => process.env.PATH,
  developerDirectory: () => process.env.DEVELOPER_DIR,
  exists: (path) => fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false)),
});

export const layer = Layer.effect(
  EnvironmentHost,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const subscriptionAuth = yield* SubscriptionAuthService.forSecretsDir(config.secretsDir);

    return yield* make(nodeMachine(fileSystem), {
      providerHealth: {
        subscriptionStatusForInstance: (provider, instanceId) =>
          subscriptionAuth.accountStatus(provider, instanceId),
        subscriptionHealth: (instanceId) =>
          subscriptionAuth.providerInstanceRequestHealth(instanceId),
      },
    });
  }),
).pipe(Layer.provide(ProjectionProjectRepositoryLive));
