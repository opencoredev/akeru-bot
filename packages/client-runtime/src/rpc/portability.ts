import {
  WS_METHODS,
  type PortabilityImportPreview,
  type PortabilityProjectFolderMap,
} from "@t3tools/contracts";

import { request } from "./client.ts";

export const exportPortabilityArchive = () => request(WS_METHODS.portabilityExport, {});

export const previewPortabilityArchive = (
  contents: string,
  projectFolders: PortabilityProjectFolderMap = {},
) => request(WS_METHODS.portabilityPreviewImport, { contents, projectFolders });

export const applyPortabilityArchive = (
  contents: string,
  preview: Pick<PortabilityImportPreview, "snapshotSequence" | "stateChecksum">,
  projectFolders: PortabilityProjectFolderMap = {},
) =>
  request(WS_METHODS.portabilityApplyImport, {
    contents,
    projectFolders,
    expectedSnapshotSequence: preview.snapshotSequence,
    expectedStateChecksum: preview.stateChecksum,
  });
