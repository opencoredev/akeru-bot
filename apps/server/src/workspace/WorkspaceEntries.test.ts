import * as Deferred from "effect/Deferred";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FileFinder } from "@ff-labs/fff-node";
import { it, afterEach, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-entries-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn(function* (opts?: { prefix?: string; git?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: opts?.prefix ?? "t3code-workspace-entries-",
  });
  if (opts?.git) {
    yield* git(dir, ["init"]);
  }
  return dir;
});

function writeTextFile(
  cwd: string,
  relativePath: string,
  contents = "",
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "WorkspaceEntries.test.git",
      command: "git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const searchWorkspaceEntries = (input: {
  cwd: string;
  query: string;
  limit: number;
  kind?: "file" | "directory";
}) =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* workspaceEntries.search(input);
  });

describe("workspace refresh worker", () => {
  it.effect("allows publication and other workspaces while a scan is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startedA = yield* Deferred.make<void>();
        const startedB = yield* Deferred.make<void>();
        const releaseA = yield* Deferred.make<void>();
        const releaseB = yield* Deferred.make<void>();
        const worker = yield* WorkspaceEntries.makeWorkspaceRefreshWorker((cwd) =>
          cwd === "/a"
            ? Deferred.succeed(startedA, undefined).pipe(Effect.andThen(Deferred.await(releaseA)))
            : Deferred.succeed(startedB, undefined).pipe(Effect.andThen(Deferred.await(releaseB))),
        );

        yield* worker.request("/a");
        yield* Deferred.await(startedA);
        yield* worker.request("/b");
        yield* Deferred.await(startedB);

        const bFresh = yield* Deferred.make<void>();
        yield* worker
          .awaitCurrent("/b")
          .pipe(Effect.andThen(Deferred.succeed(bFresh, undefined)), Effect.forkScoped);
        yield* Deferred.succeed(releaseB, undefined);
        yield* Deferred.await(bFresh);
        expect(yield* Deferred.isDone(releaseA)).toBe(false);

        const drained = yield* Deferred.make<void>();
        yield* worker.drain.pipe(
          Effect.andThen(Deferred.succeed(drained, undefined)),
          Effect.forkScoped,
        );
        expect(yield* Deferred.isDone(drained)).toBe(false);
        yield* Deferred.succeed(releaseA, undefined);
        yield* Deferred.await(drained);
      }),
    ),
  );

  it.effect("coalesces requests during a scan into one follow-up generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();
        let scans = 0;
        const worker = yield* WorkspaceEntries.makeWorkspaceRefreshWorker(() => {
          scans += 1;
          return scans === 1
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
              )
            : Deferred.succeed(secondStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSecond)),
              );
        });

        yield* worker.request("/workspace");
        yield* Deferred.await(firstStarted);
        yield* worker.request("/workspace");
        yield* worker.request("/workspace");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);
        expect(scans).toBe(2);

        const fresh = yield* Deferred.make<void>();
        yield* worker
          .awaitCurrent("/workspace")
          .pipe(Effect.andThen(Deferred.succeed(fresh, undefined)), Effect.forkScoped);
        expect(yield* Deferred.isDone(fresh)).toBe(false);
        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(fresh);
        yield* worker.drain;
        expect(scans).toBe(2);
      }),
    ),
  );

  it.effect("bounds concurrent scans and can refresh an idle workspace again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const twoStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let active = 0;
        let maximum = 0;
        let scans = 0;
        const worker = yield* WorkspaceEntries.makeWorkspaceRefreshWorker(() =>
          Effect.gen(function* () {
            scans += 1;
            active += 1;
            maximum = Math.max(maximum, active);
            if (active === 2) yield* Deferred.succeed(twoStarted, undefined);
            yield* Deferred.await(release);
            active -= 1;
          }),
        );
        for (const cwd of ["/a", "/b", "/c", "/d"]) yield* worker.request(cwd);
        yield* Deferred.await(twoStarted);
        yield* Deferred.succeed(release, undefined);
        yield* worker.drain;
        expect(maximum).toBe(2);
        expect(scans).toBe(4);
        yield* worker.request("/a");
        yield* worker.awaitCurrent("/a");
        yield* worker.drain;
        expect(scans).toBe(5);
      }),
    ),
  );

  it.effect("completes failed generations and remains drainable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let scans = 0;
        const worker = yield* WorkspaceEntries.makeWorkspaceRefreshWorker(() =>
          Effect.sync(() => {
            scans += 1;
            if (scans === 1) throw new Error("scan failed");
          }),
        );

        yield* worker.request("/workspace");
        yield* worker.drain;
        yield* worker.request("/workspace");
        yield* worker.drain;
        expect(scans).toBe(2);
      }),
    ),
  );
});

it.layer(TestLayer, { excludeTestServices: true })("WorkspaceEntries", (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("list", () => {
    it.effect("returns the complete cached workspace index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "README.md");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* workspaceEntries.list({ cwd });

        expect(result.entries).toEqual(
          expect.arrayContaining([
            { path: "src", kind: "directory" },
            { path: "src/components", kind: "directory" },
            {
              path: "src/components/Composer.tsx",
              kind: "file",
            },
            { path: "README.md", kind: "file" },
          ]),
        );
        expect(result.entries.some((entry) => entry.path.startsWith("node_modules"))).toBe(false);
        expect(result.truncated).toBe(false);
      }),
    );
  });

  describe("search", () => {
    it.effect("returns files and directories relative to cwd", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir();
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "README.md");
        yield* writeTextFile(cwd, ".git/HEAD");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/components");
        expect(paths).toContain("src/components/Composer.tsx");
        expect(paths).toContain("README.md");
        expect(paths.some((entryPath) => entryPath.startsWith(".git"))).toBe(false);
        expect(paths.some((entryPath) => entryPath.startsWith("node_modules"))).toBe(false);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("filters and ranks entries by query", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-query-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "compo", limit: 5 });

        expect(result.entries.length).toBeGreaterThan(0);
        expect(result.entries.some((entry) => entry.path === "src/components")).toBe(true);
        expect(result.entries.every((entry) => entry.path.toLowerCase().includes("compo"))).toBe(
          true,
        );
      }),
    );

    it.effect("supports fuzzy subsequence queries for composer path search", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fuzzy-query-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "cmp", limit: 10 });
        const paths = result.entries.map((entry) => entry.path);

        expect(result.entries.length).toBeGreaterThan(0);
        expect(paths).toContain("src/components");
        expect(paths).toContain("src/components/Composer.tsx");
      }),
    );

    it.effect("prioritizes exact basename matches ahead of broader path matches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-exact-ranking-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "docs/composer.tsx-notes.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "Composer.tsx", limit: 5 });

        expect(result.entries[0]?.path).toBe("src/components/Composer.tsx");
      }),
    );

    it.effect("tracks truncation without sorting every fuzzy match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fuzzy-limit-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/components/composePrompt.ts");
        yield* writeTextFile(cwd, "docs/composition.md");

        const result = yield* searchWorkspaceEntries({ cwd, query: "cmp", limit: 1 });

        expect(result.entries).toHaveLength(1);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect("applies the file filter before limiting search results", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-file-limit-" });
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "src/internal.ts");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "src",
          limit: 1,
          kind: "file",
        });

        expect(result.entries).toEqual([{ path: "src/index.ts", kind: "file" }]);
        expect(result.truncated).toBe(true);
      }),
    );

    it.effect("answers an empty file-filtered query with a bounded file listing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-empty-query-" });
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "README.md");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "",
          limit: 10,
          kind: "file",
        });

        const paths = result.entries.map((entry) => entry.path);
        expect(paths).toHaveLength(2);
        expect(paths).toContain("src/index.ts");
        expect(paths).toContain("README.md");
        expect(result.entries.every((entry) => entry.kind === "file")).toBe(true);
      }),
    );

    it.effect("returns only directories for the directory filter", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-directory-filter-" });
        yield* writeTextFile(cwd, "src/index.ts");

        const result = yield* searchWorkspaceEntries({
          cwd,
          query: "src",
          limit: 10,
          kind: "directory",
        });

        expect(result.entries).toEqual([{ path: "src", kind: "directory" }]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect("excludes gitignored paths for git repositories", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-gitignore-", git: true });
        yield* writeTextFile(cwd, ".gitignore", ".convex/\nconvex/\nignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* writeTextFile(cwd, "ignored.txt", "ignore me");
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "convex/UOoS-l/convex_local_storage/modules/data.json", "{}");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths).not.toContain("ignored.txt");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
        expect(paths.some((entryPath) => entryPath.startsWith("convex/"))).toBe(false);
      }),
    );

    it.effect("excludes tracked paths that match ignore rules", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({
          prefix: "t3code-workspace-tracked-gitignore-",
          git: true,
        });
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");
        yield* git(cwd, ["add", ".convex/local-storage/data.json", "src/keep.ts"]);
        yield* writeTextFile(cwd, ".gitignore", ".convex/\n");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
      }),
    );

    it.effect("excludes .convex in non-git workspaces", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-non-git-convex-" });
        yield* writeTextFile(cwd, ".convex/local-storage/data.json", "{}");
        yield* writeTextFile(cwd, "src/keep.ts", "export {};");

        const result = yield* searchWorkspaceEntries({ cwd, query: "", limit: 100 });
        const paths = result.entries.map((entry) => entry.path);

        expect(paths).toContain("src");
        expect(paths).toContain("src/keep.ts");
        expect(paths.some((entryPath) => entryPath.startsWith(".convex/"))).toBe(false);
      }),
    );

    it.effect("supports typo-resistant file search through fff", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-fff-typo-" });
        yield* writeTextFile(cwd, "src/components/Composer.tsx");

        const result = yield* searchWorkspaceEntries({ cwd, query: "compoesr", limit: 10 });

        expect(result.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: "src/components/Composer.tsx" }),
          ]),
        );
      }),
    );

    it.effect("rebuilds the cached index after refresh fails", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ prefix: "t3code-workspace-refresh-failure-" });
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");

        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const createSpy = vi.spyOn(FileFinder, "create");
        yield* workspaceEntries.list({ cwd });
        expect(createSpy).toHaveBeenCalledTimes(1);

        vi.spyOn(FileFinder.prototype, "scanFiles").mockReturnValueOnce({
          ok: false,
          error: "scan failed",
        });
        yield* workspaceEntries.refresh(cwd);

        yield* workspaceEntries.list({ cwd });
        expect(createSpy).toHaveBeenCalledTimes(2);
      }),
    );
  });
});
