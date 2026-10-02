import { squashAtomCommandFailure } from "@akeru/client-runtime/state/runtime";

import type { useI18n } from "../../i18n";

export function commandFailureMessage(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  t: ReturnType<typeof useI18n>["t"],
): string {
  const error = squashAtomCommandFailure(result);

  return error instanceof Error ? error.message : t("The environment rejected the change.");
}

/**
 * The roster row focus lands on once an archived one is gone: the row that takes
 * its place, else the row above it, else nothing — meaning the roster list
 * itself, because the row focus would have returned to is on its way out.
 * Keys are `rosterItemKey` values, so a surviving group can take the focus too.
 */
export function focusTargetAfterRosterArchive(
  rowKeys: readonly string[],
  archivedKey: string,
): string | null {
  const index = rowKeys.indexOf(archivedKey);

  if (index === -1) return rowKeys[0] ?? null;

  return rowKeys[index + 1] ?? rowKeys[index - 1] ?? null;
}

/**
 * Runs one create-bot submission at a time. `NewBotDialog` stays mounted while
 * the command is awaited, so a second submit would dispatch a second create and
 * leave the pending-selection id on whichever request happened to settle last.
 * The latch is a ref rather than state because both submits land before React
 * has re-rendered the dialog with `submitting`.
 */
export async function runCreateBotOnce(
  inFlight: { current: boolean },
  create: () => Promise<void>,
): Promise<void> {
  if (inFlight.current) return;
  inFlight.current = true;

  try {
    await create();
  } finally {
    inFlight.current = false;
  }
}
