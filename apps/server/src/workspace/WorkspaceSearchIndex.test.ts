import { FileFinder, type FileItem } from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const unusedFinderMethods = () => ({
  directorySearch: () => {
    throw new Error("unused directory search");
  },
  fileSearch: () => {
    throw new Error("unused file search");
  },
  mixedSearch: () => {
    throw new Error("unused mixed search");
  },
  scanFiles: () => {
    throw new Error("unused refresh");
  },
});

function fileItem(relativePath: string): FileItem {
  return {
    relativePath,
    fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    size: 1,
    modified: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    totalFrecencyScore: 0,
    gitStatus: "clean",
  };
}

it.effect("filters image searches before applying the result limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const items = [
        ...Array.from({ length: 200 }, (_, index) => fileItem(`src/file-${index}.ts`)),
        fileItem("public/icon.svg"),
      ];

      const fileSearch = vi.fn(() => ({
        ok: true as const,
        value: {
          items,
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));

      const finder = {
        ...unusedFinderMethods(),
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({
          ok: true as const,
          value: true,
        })),
        fileSearch,
      };

      const create = () => ({ ok: true as const, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", create);
      const resultWithoutKind = yield* searchIndex.search("", 200, undefined, true);
      const resultWithDirectoryKind = yield* searchIndex.search("", 200, "directory", true);

      expect(resultWithoutKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(resultWithDirectoryKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch).toHaveBeenCalledWith("", { pageSize: 25_002 });
    }),
  ),
);

it.effect("preserves unexpected FileFinder creation failures", () =>
  Effect.gen(function* () {
    const cause = new Error("native initialization failed");
    vi.spyOn(FileFinder, "create").mockImplementationOnce(() => {
      throw cause;
    });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project")),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexCreateFailed",
      cwd: "/workspace/project",
      reason: "FileFinder.create threw unexpectedly.",
      cause,
    });
  }),
);

it.effect("keeps returned FileFinder creation diagnostics out of the cause chain", () =>
  Effect.gen(function* () {
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({
      ok: false,
      error: "native index rejected the directory",
    });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project")),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexCreateFailed",
      cwd: "/workspace/project",
      reason: "native index rejected the directory",
    });
    expect(error.cause).toBeUndefined();
  }),
);

it.effect("waits for the full index warmup before returning", () =>
  Effect.gen(function* () {
    const waitForIndexReady = vi.fn(async () => ({ ok: true as const, value: true }));

    const finder = {
      ...unusedFinderMethods(),
      destroy: vi.fn(),
      waitForIndexReady,
    };

    const create = () => ({ ok: true as const, value: finder });

    yield* Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", create));

    expect(waitForIndexReady).toHaveBeenCalledWith(15_000);
  }),
);

it.effect("preserves a full-index warmup timeout as a structured error", () =>
  Effect.gen(function* () {
    const finder = {
      ...unusedFinderMethods(),
      destroy: vi.fn(),
      waitForIndexReady: vi.fn(async () => ({
        ok: true as const,
        value: false,
      })),
    };

    const create = () => ({ ok: true as const, value: finder });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", create)),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexScanTimedOut",
      cwd: "/workspace/project",
      timeout: "15 seconds",
    });
  }),
);

it.effect("preserves FileFinder destroy failures as structured defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native destroy failed");

    const finder = {
      ...unusedFinderMethods(),
      destroy: vi.fn(() => {
        throw cause;
      }),
      waitForIndexReady: vi.fn(async () => ({
        ok: true as const,
        value: true,
      })),
    };

    const create = () => ({ ok: true as const, value: finder });

    const exit = yield* Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", create)).pipe(
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);

    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(WorkspaceSearchIndex.WorkspaceSearchIndexDestroyFailed);
      expect(error).toMatchObject({
        _tag: "WorkspaceSearchIndexDestroyFailed",
        cwd: "/workspace/project",
        cause,
      });
    }
  }),
);

it.effect("keeps returned search diagnostics out of the cause chain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const finder = {
        ...unusedFinderMethods(),
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({
          ok: true as const,
          value: true,
        })),
        mixedSearch: vi.fn(() => ({
          ok: false as const,
          error: "native query rejected",
        })),
        scanFiles: vi.fn(() => ({
          ok: false as const,
          error: "native refresh rejected",
        })),
      };

      const create = () => ({ ok: true as const, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", create);
      const query = "authorization: Bearer secret-token";
      const searchError = yield* Effect.flip(searchIndex.search(query, 3));
      const refreshError = yield* Effect.flip(searchIndex.refresh());

      expect(searchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 4,
        reason: "native query rejected",
      });
      expect(searchError).not.toHaveProperty("query");
      expect(searchError.message).not.toMatch(/Bearer|secret-token/);
      expect(searchError.cause).toBeUndefined();
      expect(refreshError).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        cwd: "/workspace/project",
        reason: "native refresh rejected",
      });
      expect(refreshError.cause).toBeUndefined();
    }),
  ),
);
