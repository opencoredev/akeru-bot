import { WS_METHODS, type PortabilityImportPreview } from "@t3tools/contracts";

import { request } from "./client.ts";

export const exportPortabilityArchive = () => request(WS_METHODS.portabilityExport, {});

export const previewPortabilityArchive = (contents: string) =>
  request(WS_METHODS.portabilityPreviewImport, { contents });

export const applyPortabilityArchive = (
  contents: string,
  preview: Pick<PortabilityImportPreview, "snapshotSequence" | "stateChecksum">,
) =>
  request(WS_METHODS.portabilityApplyImport, {
    contents,
    expectedSnapshotSequence: preview.snapshotSequence,
    expectedStateChecksum: preview.stateChecksum,
  });
