import { PORTABILITY_ARCHIVE_MAX_CHARS, type PortabilityImportPreview } from "@t3tools/contracts";

export function portabilityArchiveFileError(size: number): string | null {
  return size > PORTABILITY_ARCHIVE_MAX_CHARS ? "Archives must be 20 MB or smaller." : null;
}

export function canApplyPortabilityPreview(preview: PortabilityImportPreview): boolean {
  return preview.additions.length + preview.changes.length > 0;
}
