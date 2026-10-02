import { Predicate } from "effect";
import type { PreviewSessionSnapshot, ProjectScript } from "@akeru/contracts";

export function shouldShowPreviewEmptyState(snapshot: PreviewSessionSnapshot | null): boolean {
  return snapshot === null || Predicate.isTagged(snapshot.navStatus, "Idle");
}

export function getConfiguredPreviewUrls(
  scripts: ReadonlyArray<ProjectScript> | undefined,
): ReadonlyArray<string> {
  return scripts?.flatMap((script) => (script.previewUrl ? [script.previewUrl] : [])) ?? [];
}
