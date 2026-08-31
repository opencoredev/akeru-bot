import type { PortabilityImportPreview } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PORTABILITY_ARCHIVE_MAX_CHARS } from "@t3tools/contracts";

import {
  canApplyPortabilityPreview,
  portabilityArchiveFileError,
} from "./PortabilitySettings.logic";

const preview: PortabilityImportPreview = {
  snapshotSequence: 1,
  stateChecksum: "0".repeat(64),
  additions: [],
  changes: [],
  conflicts: [],
  missingProviders: [],
  skippedSecrets: [],
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
