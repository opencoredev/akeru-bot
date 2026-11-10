import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";

import { linuxMemory } from "./EnvironmentHost.ts";
import {
  cgroupAncestors,
  cgroupMemoryLimit,
  cgroupMemoryReading,
  cgroupV1MemoryPath,
  cgroupV2Path,
} from "./EnvironmentHostMemory.ts";

const GIB = 1024 ** 3;

const HOST_TOTAL = 64 * GIB;

const MEMINFO = `MemTotal: ${64 * 1024 * 1024} kB\nMemAvailable: ${48 * 1024 * 1024} kB\n`;

const filesystemWith = (files: Readonly<Record<string, string>>) =>
  FileSystem.makeNoop({
    readFileString: (path) => {
      const content = files[path];

      return content === undefined
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path,
            }),
          )
        : Effect.succeed(content);
    },
  });

describe("cgroup paths", () => {
  it("reads the cgroup v2 path and ignores v1 lines", () => {
    assert.strictEqual(cgroupV2Path("12:memory:/docker/abc\n0::/\n"), "/");
    assert.strictEqual(cgroupV2Path("0::/user.slice/app.scope\n"), "/user.slice/app.scope");
    assert.isUndefined(cgroupV2Path("4:memory:/docker/abc\n"));
  });

  it("reads the cgroup v1 memory controller path, including shared controller lines", () => {
    assert.strictEqual(cgroupV1MemoryPath("5:cpu:/x\n9:memory:/docker/abc\n0::/\n"), "/docker/abc");
    assert.strictEqual(cgroupV1MemoryPath("4:cpuacct,memory:/a/b\n"), "/a/b");
    assert.isUndefined(cgroupV1MemoryPath("3:memory_recursiveprot:/a\n0::/\n"));
  });

  it("lists a group and each parent up to the root", () => {
    assert.deepStrictEqual(cgroupAncestors("/a/b"), ["/a/b", "/a", "/"]);
    assert.deepStrictEqual(cgroupAncestors("/"), ["/"]);
  });
});

describe("cgroupMemoryReading", () => {
  const reading = (limit: string, current = "1024", stat = "") =>
    cgroupMemoryReading({
      limit,
      current,
      stat,
      inactiveFileField: "inactive_file",
      hostTotalBytes: HOST_TOTAL,
    });

  it("counts reclaimable inactive file cache as free", () => {
    assert.deepStrictEqual(reading(`${4 * GIB}\n`, `${3 * GIB}\n`, `inactive_file ${GIB}\n`), {
      limitBytes: 4 * GIB,
      usedBytes: 2 * GIB,
    });
  });

  it("ignores an unlimited group and a limit above the host's memory", () => {
    assert.isUndefined(reading("max\n"));
    assert.isUndefined(reading("9223372036854771712\n"));
    assert.isUndefined(reading(`${HOST_TOTAL}`));
  });
});

describe("linuxMemory", () => {
  it.effect("reports the container's limit instead of the host's free memory", () =>
    Effect.gen(function* () {
      const fileSystem = filesystemWith({
        "/proc/meminfo": MEMINFO,
        "/proc/self/cgroup": "0::/\n",
        "/sys/fs/cgroup/memory.max": `${2 * GIB}\n`,
        "/sys/fs/cgroup/memory.current": `${1.75 * GIB}\n`,
        "/sys/fs/cgroup/memory.stat": "anon 1\ninactive_file 0\n",
      });

      assert.deepStrictEqual(yield* linuxMemory(fileSystem, HOST_TOTAL), {
        availableBytes: 0.25 * GIB,
        totalBytes: 2 * GIB,
      });
    }),
  );

  it.effect("uses the tightest limit among the process's cgroup and its parents", () =>
    Effect.gen(function* () {
      const fileSystem = filesystemWith({
        "/proc/self/cgroup": "0::/system.slice/akeru.service\n",
        "/sys/fs/cgroup/system.slice/akeru.service/memory.max": "max\n",
        "/sys/fs/cgroup/system.slice/memory.max": `${8 * GIB}\n`,
        "/sys/fs/cgroup/system.slice/memory.current": `${7 * GIB}\n`,
        "/sys/fs/cgroup/system.slice/memory.stat": "",
      });

      assert.deepStrictEqual(yield* cgroupMemoryLimit(fileSystem, HOST_TOTAL), {
        limitBytes: 8 * GIB,
        usedBytes: 7 * GIB,
      });
    }),
  );

  it.effect("keeps a child's smaller limit when a fuller parent has less free memory", () =>
    Effect.gen(function* () {
      const fileSystem = filesystemWith({
        "/proc/self/cgroup": "0::/parent/child\n",
        "/sys/fs/cgroup/parent/child/memory.max": `${2 * GIB}\n`,
        "/sys/fs/cgroup/parent/child/memory.current": `${GIB}\n`,
        "/sys/fs/cgroup/parent/child/memory.stat": "",
        "/sys/fs/cgroup/parent/memory.max": `${16 * GIB}\n`,
        "/sys/fs/cgroup/parent/memory.current": `${16 * GIB - 0.75 * GIB}\n`,
        "/sys/fs/cgroup/parent/memory.stat": "",
      });

      // 2 GiB is the server's limit, and the parent's 0.75 GiB is the most it can still use.
      assert.deepStrictEqual(yield* cgroupMemoryLimit(fileSystem, HOST_TOTAL), {
        limitBytes: 2 * GIB,
        usedBytes: 1.25 * GIB,
      });
    }),
  );

  it.effect("falls back to the cgroup v1 memory controller", () =>
    Effect.gen(function* () {
      const fileSystem = filesystemWith({
        "/proc/self/cgroup": "9:memory:/docker/abc\n",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${4 * GIB}\n`,
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": `${3 * GIB}\n`,
        "/sys/fs/cgroup/memory/memory.stat": `total_inactive_file ${GIB}\n`,
      });

      assert.deepStrictEqual(yield* cgroupMemoryLimit(fileSystem, HOST_TOTAL), {
        limitBytes: 4 * GIB,
        usedBytes: 2 * GIB,
      });
    }),
  );

  it.effect("reads a cgroup v1 limit set on the process's own group below the root", () =>
    Effect.gen(function* () {
      const fileSystem = filesystemWith({
        "/proc/self/cgroup": "9:memory:/docker/abc\n",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": `${40 * GIB}\n`,
        "/sys/fs/cgroup/memory/docker/memory.limit_in_bytes": "9223372036854771712\n",
        "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": `${2 * GIB}\n`,
        "/sys/fs/cgroup/memory/docker/abc/memory.usage_in_bytes": `${1.5 * GIB}\n`,
        "/sys/fs/cgroup/memory/docker/abc/memory.stat": `total_inactive_file ${0.5 * GIB}\n`,
      });

      assert.deepStrictEqual(yield* cgroupMemoryLimit(fileSystem, HOST_TOTAL), {
        limitBytes: 2 * GIB,
        usedBytes: GIB,
      });
    }),
  );

  it.effect("keeps the host readings when no cgroup limit applies", () =>
    Effect.gen(function* () {
      const fileSystem = filesystemWith({
        "/proc/meminfo": MEMINFO,
        "/proc/self/cgroup": "0::/user.slice\n",
        "/sys/fs/cgroup/user.slice/memory.max": "max\n",
      });

      assert.deepStrictEqual(yield* linuxMemory(fileSystem, HOST_TOTAL), {
        availableBytes: 48 * GIB,
        totalBytes: HOST_TOTAL,
      });
    }),
  );
});
