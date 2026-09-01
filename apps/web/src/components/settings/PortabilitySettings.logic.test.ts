import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ProjectId, type PortabilityImportPreview } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PORTABILITY_ARCHIVE_MAX_CHARS } from "@t3tools/contracts";

import {
  canApplyPortabilityPreview,
  portabilityArchiveFileError,
  portabilityProjectPickerTarget,
  updatePortabilityProjectFolderMap,
} from "./PortabilitySettings.logic";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

describe("portabilityProjectPickerTarget", () => {
  it("uses only native or desktop-local folder pickers", () => {
    expect(
      portabilityProjectPickerTarget(
        new PrimaryConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          httpBaseUrl: "http://127.0.0.1:3773",
          label: "This device",
          wsBaseUrl: "ws://127.0.0.1:3773",
        }),
      ),
    ).toBeNull();
    expect(
      portabilityProjectPickerTarget(
        new BearerConnectionTarget({
          connectionId: "local:wsl:Ubuntu",
          environmentId: ENVIRONMENT_ID,
          label: "WSL",
        }),
      ),
    ).toBe("wsl:Ubuntu");
    expect(
      portabilityProjectPickerTarget(
        new RelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: "Remote" }),
      ),
    ).toBeUndefined();
  });
});

const preview: PortabilityImportPreview = {
  snapshotSequence: 1,
  stateChecksum: "0".repeat(64),
  additions: [],
  changes: [],
  conflicts: [],
  missingProviders: [],
  skippedSecrets: [],
  projectFolders: [],
  unsupported: [],
};

describe("canApplyPortabilityPreview", () => {
  it("allows only previews with safe additions or changes", () => {
    expect(canApplyPortabilityPreview(preview)).toBe(false);
    expect(
      canApplyPortabilityPreview({
        ...preview,
        conflicts: [{ recordType: "bot", id: "bot-1", title: "Bot" }],
      }),
    ).toBe(false);
    expect(
      canApplyPortabilityPreview({
        ...preview,
        changes: [{ recordType: "mcp-server", id: "mcp-1", title: "MCP server" }],
      }),
    ).toBe(true);
    const partial = {
      ...preview,
      changes: [{ recordType: "mcp-server" as const, id: "mcp-1", title: "MCP server" }],
      projectFolders: [
        {
          projectId: ProjectId.make("project-1"),
          title: "Project",
          workspaceName: "project",
          destination: null,
        },
      ],
    };
    expect(canApplyPortabilityPreview(partial)).toBe(true);
    expect(
      canApplyPortabilityPreview({
        ...preview,
        additions: [{ recordType: "project", id: "project-1", title: "Project" }],
        projectFolders: [
          {
            projectId: ProjectId.make("project-1"),
            title: "Project",
            workspaceName: "project",
            destination: null,
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("portabilityArchiveFileError", () => {
  it("rejects files larger than the archive limit before reading them", () => {
    expect(portabilityArchiveFileError(PORTABILITY_ARCHIVE_MAX_CHARS)).toBeNull();
    expect(portabilityArchiveFileError(PORTABILITY_ARCHIVE_MAX_CHARS + 1)).toBe(
      "Archives must be 20 MB or smaller.",
    );
  });
});

describe("updatePortabilityProjectFolderMap", () => {
  it("keeps prior folder picks and can clear one mapping", () => {
    const first = ProjectId.make("project-1");
    const second = ProjectId.make("project-2");
    const withBoth = updatePortabilityProjectFolderMap(
      updatePortabilityProjectFolderMap({}, first, " /tmp/first "),
      second,
      "/tmp/second",
    );

    expect(withBoth).toEqual({
      [first]: "/tmp/first",
      [second]: "/tmp/second",
    });
    expect(updatePortabilityProjectFolderMap(withBoth, first, "")).toEqual({
      [second]: "/tmp/second",
    });
  });
});
