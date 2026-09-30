import type { ScopedThreadRef } from "@akeru/contracts";

export function resolveThreadSelectionDetailRef(
  selectedThreadRef: ScopedThreadRef | null,
  hasSelectedThreadShell: boolean,
): ScopedThreadRef | null {
  return hasSelectedThreadShell ? null : selectedThreadRef;
}
