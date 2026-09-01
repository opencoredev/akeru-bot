import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  PORTABILITY_ARCHIVE_MAX_CHARS,
  type PortabilityImportPreview,
  type PortabilityProjectFolderMap,
  type ProjectId,
} from "@t3tools/contracts";

import { desktopLocalBackendId } from "../../connection/desktopLocal";

export function portabilityProjectPickerTarget(
  target: ConnectionTarget | null,
): string | null | undefined {
  if (target === null) return undefined;
  if (target._tag === "PrimaryConnectionTarget") return null;
  return desktopLocalBackendId(target) ?? undefined;
}

export function updatePortabilityProjectFolderMap(
  current: PortabilityProjectFolderMap,
  projectId: ProjectId,
  destination: string,
): PortabilityProjectFolderMap {
  const next = Object.fromEntries(
    Object.entries(current).filter(([candidateId]) => candidateId !== projectId),
  ) as PortabilityProjectFolderMap;
  const normalizedDestination = destination.trim();
  return normalizedDestination ? { ...next, [projectId]: normalizedDestination } : next;
}

export function portabilityArchiveFileError(size: number): string | null {
  return size > PORTABILITY_ARCHIVE_MAX_CHARS ? "Archives must be 20 MB or smaller." : null;
}

export function canApplyPortabilityPreview(preview: PortabilityImportPreview): boolean {
  return preview.additions.length + preview.changes.length > 0;
}
