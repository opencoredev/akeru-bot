import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";

/** A cgroup memory limit and the memory charged against it, in bytes. */
export interface CgroupMemory {
  readonly limitBytes: number;
  readonly usedBytes: number;
}

/** The process's cgroup v2 path from `/proc/self/cgroup`, such as `/` inside a container. */
export const cgroupV2Path = (procSelfCgroup: string): string | undefined =>
  /^0::(\/.*)$/m.exec(procSelfCgroup)?.[1]?.trim();

/**
 * The process's cgroup v1 memory controller path from `/proc/self/cgroup`, such
 * as `/docker/abc` on a host-visible hierarchy. The controller may share a line
 * with others, as in `4:cpuacct,memory:/a`.
 */
export const cgroupV1MemoryPath = (procSelfCgroup: string): string | undefined =>
  procSelfCgroup
    .split("\n")
    .map((line) => /^\d+:([^:]*):(\/.*)$/.exec(line.trim()))
    .find((match) => match?.[1]?.split(",").includes("memory") === true)?.[2];

/** A cgroup path and each of its parents, ending at the root: `/a/b`, `/a`, `/`. */
export const cgroupAncestors = (path: string): ReadonlyArray<string> => {
  const parts = path.split("/").filter((part) => part.length > 0);

  return parts.map((_, index) => `/${parts.slice(0, parts.length - index).join("/")}`).concat("/");
};

const parseBytes = (text: string): number | undefined => {
  const trimmed = text.trim();

  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
};

const statBytes = (stat: string, field: string): number => {
  const value = new RegExp(`^${field} (\\d+)$`, "m").exec(stat)?.[1];

  return value === undefined ? 0 : Number(value);
};

/**
 * Reads one cgroup's limit and use. `limit` is `max` (v2) or a huge number
 * (v1) when there is no limit, so a limit at or above the host's memory is
 * ignored. Inactive file cache is reclaimable, so it does not count as used,
 * matching how `MemAvailable` treats page cache on the host.
 */
export const cgroupMemoryReading = (input: {
  readonly limit: string;
  readonly current: string;
  readonly stat: string;
  readonly inactiveFileField: "inactive_file" | "total_inactive_file";
  readonly hostTotalBytes: number;
}): CgroupMemory | undefined => {
  const limitBytes = parseBytes(input.limit);
  const currentBytes = parseBytes(input.current);

  if (limitBytes === undefined || currentBytes === undefined) return undefined;

  if (!(limitBytes > 0) || limitBytes >= input.hostTotalBytes) return undefined;

  return {
    limitBytes,
    usedBytes: Math.max(0, currentBytes - statBytes(input.stat, input.inactiveFileField)),
  };
};

const headroom = (memory: CgroupMemory) => memory.limitBytes - memory.usedBytes;

const readOrEmpty = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

/**
 * The tightest memory limit on this process's cgroups, or `undefined` when no
 * limit applies. Checks the process's cgroup v2 group and each parent, then
 * falls back to its cgroup v1 memory group and each parent. A container's own
 * limit is the cgroup root inside it, so this covers Docker and systemd limits
 * alike.
 * Every reading is a file read; nothing starts a subprocess.
 */
export const cgroupMemoryLimit = (fileSystem: FileSystem.FileSystem, hostTotalBytes: number) =>
  Effect.gen(function* () {
    const read = (path: string) => readOrEmpty(fileSystem, path);

    const readGroup = (
      directory: string,
      inactiveFileField: "inactive_file" | "total_inactive_file",
      files: { readonly limit: string; readonly current: string },
    ) =>
      Effect.gen(function* () {
        const limit = yield* read(`${directory}/${files.limit}`);

        // Skip the other reads for the common unlimited group.
        if (parseBytes(limit) === undefined) return undefined;

        const [current, stat] = yield* Effect.all([
          read(`${directory}/${files.current}`),
          read(`${directory}/memory.stat`),
        ]);

        return cgroupMemoryReading({ limit, current, stat, inactiveFileField, hostTotalBytes });
      });

    // The smallest limit and the smallest headroom can come from different groups, such as a
    // tight child inside a fuller parent, so each is taken on its own.
    const tightestOf = (
      groups: ReadonlyArray<Effect.Effect<CgroupMemory | undefined>>,
    ): Effect.Effect<CgroupMemory | undefined> =>
      Effect.all(groups).pipe(
        Effect.map((readings) => {
          const limited = readings.filter(Predicate.isNotUndefined);

          if (limited.length === 0) return undefined;
          const limitBytes = Math.min(...limited.map((reading) => reading.limitBytes));
          const freeBytes = Math.min(...limited.map(headroom));

          return { limitBytes, usedBytes: Math.max(0, limitBytes - Math.max(0, freeBytes)) };
        }),
      );

    // A path and each parent under one hierarchy mount. Inside a container the
    // mount is the container's own group, so missing child directories read as
    // empty and the root still carries the limit.
    const groupsUnder = (mount: string, path: string | undefined) =>
      path === undefined
        ? []
        : cgroupAncestors(path).map((group) => (group === "/" ? mount : `${mount}${group}`));

    const procSelfCgroup = yield* read("/proc/self/cgroup");

    const v2 = yield* tightestOf(
      groupsUnder("/sys/fs/cgroup", cgroupV2Path(procSelfCgroup)).map((directory) =>
        readGroup(directory, "inactive_file", { limit: "memory.max", current: "memory.current" }),
      ),
    );

    if (v2 !== undefined) return v2;

    return yield* tightestOf(
      groupsUnder("/sys/fs/cgroup/memory", cgroupV1MemoryPath(procSelfCgroup) ?? "/").map(
        (directory) =>
          readGroup(directory, "total_inactive_file", {
            limit: "memory.limit_in_bytes",
            current: "memory.usage_in_bytes",
          }),
      ),
    );
  });
