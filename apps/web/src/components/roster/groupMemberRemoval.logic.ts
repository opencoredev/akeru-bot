import { createTranslator } from "@akeru/client-runtime/i18n";

type Translate = (message: string, params?: Record<string, string | number>) => string;

const englishTranslate: Translate = createTranslator("en").translate;

/**
 * Explains why the member list blocks removal, so the way back out of a group
 * change is always visible. Returns null when every specialist can be removed.
 */
export function groupMemberRemovalHint(
  input: {
    readonly memberCount: number;
    readonly bossName: string | null;
    readonly canAddBot: boolean;
  },
  t: Translate = englishTranslate,
): string | null {
  if (input.memberCount <= 2) {
    return input.canAddBot
      ? t("A group needs at least two bots. Add another bot before you remove one.")
      : t("A group needs at least two bots. Create a new bot in the roster before you remove one.");
  }

  if (input.bossName !== null) {
    return t("To remove {name}, make another bot the boss first.", { name: input.bossName });
  }

  return null;
}

/** True when the removal hint explains why this row's remove button is disabled. */
export function isGroupMemberRemovalBlocked(input: {
  readonly memberCount: number;
  readonly isBoss: boolean;
}): boolean {
  return input.memberCount <= 2 || input.isBoss;
}
