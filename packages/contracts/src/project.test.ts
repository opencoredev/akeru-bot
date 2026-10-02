import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectWriteFileError,
} from "./project.ts";

const decodeSearchEntriesInput = Schema.decodeUnknownSync(ProjectSearchEntriesInput);

const decodeSearchContentsInput = Schema.decodeUnknownSync(ProjectSearchContentsInput);

describe("project search inputs", () => {
  it("allows an empty entries query for bounded frecency browsing", () => {
    const decoded = decodeSearchEntriesInput({
      cwd: "/workspace",
      query: "   ",
      limit: 10,
      kind: "file",
    });

    expect(decoded.query).toBe("");
  });

  it("preserves whitespace in content search queries", () => {
    const decoded = decodeSearchContentsInput({
      cwd: "/workspace",
      query: " foo ",
      limit: 10,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });

    expect(decoded.query).toBe(" foo ");
  });
});

describe("project RPC errors", () => {
  it("derives stable messages from structured request context while retaining causes", () => {
    const cause = new Error("sensitive platform detail");

    const searchError = ProjectSearchEntriesError.fromContext({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 20,
      failure: "search_index_search_failed",
      normalizedCwd: "/workspace",
      detail: "index unavailable",
      cause,
    });

    const readError = ProjectReadFileError.fromContext({
      cwd: "/workspace",
      relativePath: "src/index.ts",
      failure: "operation_failed",
      operation: "read",
      operationPath: "/workspace/src/index.ts",
      resolvedPath: "/workspace/src/index.ts",
      cause,
    });

    expect(searchError.message).toBe("Failed to search workspace entries in '/workspace'.");
    expect(searchError.message).not.toContain(cause.message);
    expect(searchError.normalizedCwd).toBe("/workspace");
    expect(searchError.queryLength).toBe("authorization: Bearer secret-token".length);
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.message).not.toMatch(/Bearer|secret-token/);
    expect(searchError.cause).toBe(cause);
    expect(readError.message).toBe("Failed to read workspace file 'src/index.ts' in '/workspace'.");
    expect(readError.message).not.toContain(cause.message);
    expect(readError.cause).toBe(cause);

    const contentSearchError = ProjectSearchContentsError.fromContext({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 100,
      failure: "search_index_search_failed",
      cause,
    });

    expect(contentSearchError.message).toBe("Failed to search workspace contents in '/workspace'.");
    expect(contentSearchError.message).not.toContain(cause.message);
    expect(contentSearchError).not.toHaveProperty("query");
    expect(contentSearchError.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeSearchError = Schema.decodeUnknownSync(ProjectSearchEntriesError);
    const decodeWriteError = Schema.decodeUnknownSync(ProjectWriteFileError);

    const searchError = decodeSearchError({
      _tag: "ProjectSearchEntriesError",
      message: "Legacy project search failure.",
      query: "legacy sensitive query",
    });

    const writeError = decodeWriteError({
      _tag: "ProjectWriteFileError",
      message: "Legacy project write failure.",
    });

    expect(searchError.message).toBe("Legacy project search failure.");
    expect(searchError.cwd).toBeUndefined();
    expect(searchError.queryLength).toBeUndefined();
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.failure).toBeUndefined();
    expect(writeError.message).toBe("Legacy project write failure.");
    expect(writeError.relativePath).toBeUndefined();
    expect(writeError.failure).toBeUndefined();
  });
});

const ProjectRpcError = Schema.Union([
  ProjectSearchEntriesError,
  ProjectSearchContentsError,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectWriteFileError,
]);

const encodeProjectRpcError = Schema.encodeSync(ProjectRpcError);

const decodeProjectRpcError = Schema.decodeUnknownSync(ProjectRpcError);

describe("project RPC error wire compatibility", () => {
  it("round-trips all structured errors without changing their wire fields", () => {
    const entriesContext = {
      cwd: "/workspace",
      failure: "search_index_search_failed",
    } as const;

    const searchContext = { ...entriesContext, queryLength: 4, limit: 20 };

    const fileContext = {
      cwd: "/workspace",
      relativePath: "src/index.ts",
      failure: "operation_failed",
    } as const;

    const cases = [
      [
        ProjectSearchEntriesError.fromContext(searchContext),
        {
          _tag: "ProjectSearchEntriesError",
          ...searchContext,
          message: "Failed to search workspace entries in '/workspace'.",
        },
      ],
      [
        ProjectSearchContentsError.fromContext(searchContext),
        {
          _tag: "ProjectSearchContentsError",
          ...searchContext,
          message: "Failed to search workspace contents in '/workspace'.",
        },
      ],
      [
        ProjectListEntriesError.fromContext(entriesContext),
        {
          _tag: "ProjectListEntriesError",
          ...entriesContext,
          message: "Failed to list workspace entries in '/workspace'.",
        },
      ],
      [
        ProjectReadFileError.fromContext(fileContext),
        {
          _tag: "ProjectReadFileError",
          ...fileContext,
          message: "Failed to read workspace file 'src/index.ts' in '/workspace'.",
        },
      ],
      [
        ProjectWriteFileError.fromContext(fileContext),
        {
          _tag: "ProjectWriteFileError",
          ...fileContext,
          message: "Failed to write workspace file 'src/index.ts' in '/workspace'.",
        },
      ],
    ] as const;

    for (const [error, expected] of cases) {
      expect(encodeProjectRpcError(error)).toEqual(expected);
      expect(encodeProjectRpcError(decodeProjectRpcError(expected))).toEqual(expected);
    }
  });

  it("retains legacy messages for every error schema on decode and encode", () => {
    const tags = [
      "ProjectSearchEntriesError",
      "ProjectSearchContentsError",
      "ProjectListEntriesError",
      "ProjectReadFileError",
      "ProjectWriteFileError",
    ];

    for (const _tag of tags) {
      const wire = { _tag, message: "Legacy message." };

      const decoded = decodeProjectRpcError(wire);

      expect(encodeProjectRpcError(decoded)).toEqual(wire);
    }
  });
});
