import type { ScopedThreadRef } from "@t3tools/contracts";

export function resolveThreadSelectionDetailRef(
  selectedThreadRef: ScopedThreadRef | null,
  hasSelectedThreadShell: boolean,
): ScopedThreadRef | null {
  return hasSelectedThreadShell ? null : selectedThreadRef;
}
