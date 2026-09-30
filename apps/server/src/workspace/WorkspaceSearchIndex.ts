import {
  type DirItem,
  type DirSearchResult,
  type FileItem,
  FileFinder,
  type MixedItem,
  type MixedSearchResult,
  type Result,
  type SearchResult,
} from "@ff-labs/fff-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Schema from "effect/Schema";

import type {
  ProjectEntry,
  ProjectEntryKind,
  ProjectListEntriesResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_INDEX_PAGE_SIZE = WORKSPACE_INDEX_MAX_ENTRIES + 2;
const WORKSPACE_INDEX_SCAN_TIMEOUT = "15 seconds";
const WORKSPACE_INDEX_SCAN_TIMEOUT_MS = 15_000;
const WORKSPACE_INDEX_IDLE_TTL = "15 minutes";

export class WorkspaceSearchIndexCreateFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexCreateFailed>()(
  "WorkspaceSearchIndexCreateFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to create the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexScanTimedOut extends Schema.TaggedErrorClass<WorkspaceSearchIndexScanTimedOut>()(
  "WorkspaceSearchIndexScanTimedOut",
  {
    cwd: Schema.String,
    timeout: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace search index for '${this.cwd}' did not finish scanning within ${this.timeout}`;
  }
}

export class WorkspaceSearchIndexSearchFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexSearchFailed>()(
  "WorkspaceSearchIndexSearchFailed",
  {
    cwd: Schema.String,
    queryLength: Schema.Number,
    pageSize: Schema.Number,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workspace search failed for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexRefreshFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexRefreshFailed>()(
  "WorkspaceSearchIndexRefreshFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to refresh the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexDestroyFailed extends Schema.TaggedErrorClass<WorkspaceSearchIndexDestroyFailed>()(
  "WorkspaceSearchIndexDestroyFailed",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to destroy the workspace search index for '${this.cwd}'.`;
  }
}

export type WorkspaceSearchIndexError =
  | WorkspaceSearchIndexCreateFailed
  | WorkspaceSearchIndexScanTimedOut
  | WorkspaceSearchIndexSearchFailed
  | WorkspaceSearchIndexRefreshFailed;

export class WorkspaceSearchIndex extends Context.Service<
  WorkspaceSearchIndex,
  {
    readonly list: () => Effect.Effect<ProjectListEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly search: (
      query: string,
      limit: number,
      kind?: ProjectEntryKind,
      imageOnly?: boolean,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly refresh: () => Effect.Effect<
      void,
      WorkspaceSearchIndexRefreshFailed | WorkspaceSearchIndexScanTimedOut
    >;
  }
>()("akeru-bot/workspace/WorkspaceSearchIndex") {}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function trimDirectorySeparator(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

function toProjectEntry(item: MixedItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.item.relativePath));
  if (!normalizedPath) {
    return null;
  }

  return {
    path: normalizedPath,
    kind: item.type,
  };
}

function toFileEntry(item: FileItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath));
  return normalizedPath ? { path: normalizedPath, kind: "file" } : null;
}

function toDirectoryEntry(item: DirItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath));
  return normalizedPath ? { path: normalizedPath, kind: "directory" } : null;
}

function mapFileSearchResult(
  result: SearchResult,
  limit: number,
  imageOnly = false,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toFileEntry(item);
    return entry && (!imageOnly || isWorkspaceImagePreviewPath(entry.path)) ? [entry] : [];
  });
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit || result.totalMatched > result.items.length,
  };
}

function mapDirectorySearchResult(
  result: DirSearchResult,
  limit: number,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toDirectoryEntry(item);
    return entry ? [entry] : [];
  });
  const rootDirectoryCount = result.items.some((item) => item.relativePath.length === 0) ? 1 : 0;
  return {
    entries: entries.slice(0, limit),
    truncated: result.totalMatched - rootDirectoryCount > limit,
  };
}

function mapMixedSearchResult(
  result: MixedSearchResult,
  limit: number,
): { readonly entries: ProjectEntry[]; readonly truncated: boolean } {
  const entries: ProjectEntry[] = [];
  for (const item of result.items) {
    const entry = toProjectEntry(item);
    if (entry) {
      entries.push(entry);
    }
    if (entries.length >= limit) {
      break;
    }
  }

  const rootDirectoryCount = result.items.some(
    (item) => item.type === "directory" && item.item.relativePath.length === 0,
  )
    ? 1
    : 0;
  return {
    entries,
    truncated: result.totalMatched - rootDirectoryCount > limit,
  };
}

function withDirectoryAncestors(entries: ReadonlyArray<ProjectEntry>): ProjectEntry[] {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    let parentPath = parentPathOf(entry.path);
    while (parentPath) {
      if (!entryByPath.has(parentPath)) {
        entryByPath.set(parentPath, { path: parentPath, kind: "directory" });
      }
      parentPath = parentPathOf(parentPath);
    }
  }
  return [...entryByPath.values()];
}

const createFinder = Effect.fn("WorkspaceSearchIndex.createFinder")(function* (cwd: string) {
  const result = yield* Effect.try({
    try: () =>
      FileFinder.create({
        basePath: cwd,
        disableMmapCache: true,
        // Only paths are searched, so skip the content index's scan CPU and memory.
        disableContentIndexing: true,
        aiMode: false,
        enableFsRootScanning: true,
        enableHomeDirScanning: true,
      }),
    catch: (cause) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: "FileFinder.create threw unexpectedly.",
        cause,
      }),
  });
  if (result.ok) return result.value;
  return yield* new WorkspaceSearchIndexCreateFailed({
    cwd,
    reason: result.error,
  });
});

const waitForIndexReady = Effect.fn("WorkspaceSearchIndex.waitForIndexReady")(function* <E>(
  cwd: string,
  finder: FileFinder,
  onFailure: (input: { readonly reason: string; readonly cause?: unknown }) => E,
): Effect.fn.Return<void, E | WorkspaceSearchIndexScanTimedOut> {
  const result = yield* Effect.tryPromise({
    try: () => finder.waitForIndexReady(WORKSPACE_INDEX_SCAN_TIMEOUT_MS),
    catch: (cause) =>
      onFailure({
        reason: "FileFinder.waitForIndexReady rejected unexpectedly.",
        cause,
      }),
  });
  if (!result.ok) {
    return yield* Effect.fail(onFailure({ reason: result.error }));
  }
  if (!result.value) {
    return yield* new WorkspaceSearchIndexScanTimedOut({
      cwd,
      timeout: WORKSPACE_INDEX_SCAN_TIMEOUT,
    });
  }
});

export const make = Effect.fn("WorkspaceSearchIndex.make")(function* (cwd: string) {
  const finder = yield* Effect.acquireRelease(createFinder(cwd), (finder) =>
    Effect.try({
      try: () => finder.destroy(),
      catch: (cause) => new WorkspaceSearchIndexDestroyFailed({ cwd, cause }),
    }).pipe(Effect.orDie),
  );
  yield* waitForIndexReady(
    cwd,
    finder,
    ({ reason, cause }) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason,
        cause,
      }),
  );

  const runSearch = Effect.fn("WorkspaceSearchIndex.runSearch")(function* <A>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "grep" | "mixedSearch",
    execute: () => Result<A>,
  ): Effect.fn.Return<A, WorkspaceSearchIndexSearchFailed> {
    const result = yield* Effect.try({
      try: execute,
      catch: (cause) =>
        new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize,
          reason: `FileFinder.${operation} threw unexpectedly.`,
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexSearchFailed({
        cwd,
        queryLength: query.length,
        pageSize,
        reason: result.error,
      });
    }
    return result.value;
  });

  const refresh: WorkspaceSearchIndex["Service"]["refresh"] = Effect.fn(
    "WorkspaceSearchIndex.refresh",
  )(function* () {
    const result = yield* Effect.try({
      try: () => finder.scanFiles(),
      catch: (cause) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: "FileFinder.scanFiles threw unexpectedly.",
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexRefreshFailed({
        cwd,
        reason: result.error,
      });
    }
    yield* waitForIndexReady(
      cwd,
      finder,
      ({ reason, cause }) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason,
          cause,
        }),
    );
  });

  const list: WorkspaceSearchIndex["Service"]["list"] = Effect.fn("WorkspaceSearchIndex.list")(
    function* () {
      const result = yield* runSearch("", WORKSPACE_INDEX_PAGE_SIZE, "mixedSearch", () =>
        finder.mixedSearch("", { pageSize: WORKSPACE_INDEX_PAGE_SIZE }),
      );
      const mapped = mapMixedSearchResult(result, WORKSPACE_INDEX_MAX_ENTRIES);
      const sortedEntries = withDirectoryAncestors(mapped.entries).toSorted((left, right) =>
        left.path.localeCompare(right.path),
      );
      const entries = sortedEntries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES);
      return {
        entries,
        truncated: mapped.truncated || entries.length < sortedEntries.length,
      };
    },
  );

  const search: WorkspaceSearchIndex["Service"]["search"] = Effect.fn(
    "WorkspaceSearchIndex.search",
  )(function* (query, limit, kind, imageOnly) {
    const pageSize = imageOnly ? WORKSPACE_INDEX_PAGE_SIZE : Math.max(1, limit + 1);
    if (kind === "file" || imageOnly) {
      const result = yield* runSearch(query, pageSize, "fileSearch", () =>
        finder.fileSearch(query, { pageSize }),
      );
      return mapFileSearchResult(result, limit, imageOnly);
    }
    if (kind === "directory") {
      const result = yield* runSearch(query, pageSize, "directorySearch", () =>
        finder.directorySearch(query, { pageSize }),
      );
      return mapDirectorySearchResult(result, limit);
    }
    const result = yield* runSearch(query, pageSize, "mixedSearch", () =>
      finder.mixedSearch(query, { pageSize }),
    );
    return mapMixedSearchResult(result, limit);
  });

  return WorkspaceSearchIndex.of({ list, refresh, search });
});

/**
 * A layer factory is required because every index is scoped to a concrete
 * workspace root, which is also its key. WorkspaceSearchIndexMap owns
 * memoization and idle cleanup; using a default cwd here would mix resources
 * from different workspaces.
 */
export const layer = (cwd: string) => Layer.effect(WorkspaceSearchIndex, make(cwd));

export class WorkspaceSearchIndexMap extends LayerMap.Service<WorkspaceSearchIndexMap>()(
  "akeru-bot/workspace/WorkspaceSearchIndexMap",
  {
    lookup: layer,
    idleTimeToLive: WORKSPACE_INDEX_IDLE_TTL,
  },
) {}
