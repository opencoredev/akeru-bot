import {
  resolveProviderSkillSourceKind,
  resolveProviderSkillTextIcon,
  type ProviderSkillSourceKind,
} from "@akeru/client-runtime/providerSkills";
import type { ServerProviderSkill } from "@akeru/contracts";
import {
  BlocksIcon,
  FolderIcon,
  PackageIcon,
  SettingsIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";

const SKILL_SOURCE_ICON_BY_KIND: Record<ProviderSkillSourceKind, LucideIcon> = {
  app: BlocksIcon,
  repo: FolderIcon,
  project: FolderIcon,
  personal: UserRoundIcon,
  system: SettingsIcon,
  other: PackageIcon,
};

/**
 * Draws the skill's own emoji icon, or the glyph for where the skill was
 * loaded from when the provider reported none it can show. Decorative: the
 * surrounding row or chip carries the accessible name.
 */
export function ProviderSkillIcon(props: {
  skill: Pick<ServerProviderSkill, "icon" | "path" | "scope">;
  className?: string;
}) {
  const textIcon = resolveProviderSkillTextIcon(props.skill);
  if (textIcon) {
    return (
      <span aria-hidden="true" className={props.className} data-skill-icon="own">
        {textIcon}
      </span>
    );
  }
  const Icon = SKILL_SOURCE_ICON_BY_KIND[resolveProviderSkillSourceKind(props.skill)];
  return (
    <span aria-hidden="true" className={props.className} data-skill-icon="source">
      {/* text-current keeps the host tint; menu rows otherwise mute bare svgs. */}
      <Icon className="text-current" />
    </span>
  );
}
