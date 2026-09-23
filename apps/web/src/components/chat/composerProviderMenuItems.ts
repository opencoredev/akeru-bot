import { createTranslator, type MessageKey, type TranslationParams } from "@t3tools/client-runtime/i18n";
import {
  formatProviderSkillDisplayName,
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
} from "@t3tools/client-runtime/providerSkills";
import type {
  ProviderDriverKind,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";

import { searchProviderSkills } from "../../providerSkillSearch";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";

/** The skills and commands of the provider instance that will run the next turn. */
export interface ComposerProviderCatalog {
  readonly provider: ProviderDriverKind;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

type Translate = (message: MessageKey, params?: TranslationParams) => string;

const englishTranslate: Translate = createTranslator("en").t;

type ProviderMenuItem = Extract<ComposerCommandItem, { type: "provider-slash-command" | "skill" }>;

/**
 * Ranked menu rows for a `/` or `$` trigger. `/` lists provider commands, then the
 * enabled skills when `showSkillsInSlashMenu` is on; `$` searches every skill.
 * Other triggers return no rows. Pass the active translator for the row descriptions.
 */
export function buildComposerProviderMenuItems(input: {
  readonly trigger: { readonly kind: string; readonly query: string };
  readonly catalog: ComposerProviderCatalog | null;
  readonly showSkillsInSlashMenu: boolean;
  readonly t?: Translate;
}): ProviderMenuItem[] {
  const { trigger, catalog, t = englishTranslate } = input;
  const provider = catalog?.provider;
  if (!provider) return [];
  if (trigger.kind === "slash-command") {
    const slashMenuSkills = getProviderSkillsForSlashMenu(
      catalog.skills,
      input.showSkillsInSlashMenu,
    );
    const commandItems = getProviderSlashCommandsForSlashMenu(
      catalog.slashCommands,
      slashMenuSkills,
    ).map(
      (command): ProviderMenuItem => ({
        id: `provider-slash-command:${provider}:${command.name}`,
        type: "provider-slash-command",
        provider,
        command,
        label: `/${command.name}`,
        description: command.description ?? command.input?.hint ?? t("Run provider command"),
      }),
    );
    const skillItems = slashMenuSkills.map(
      (skill): ProviderMenuItem => ({
        id: `skill:${provider}:${skill.name}`,
        type: "skill",
        provider,
        skill,
        label: `/skill:${skill.name}`,
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? t("{scope} skill", { scope: skill.scope }) : ""),
      }),
    );
    return searchSlashCommandItems(
      [...commandItems, ...skillItems],
      trigger.query.trim().toLowerCase(),
    );
  }
  if (trigger.kind === "skill") {
    return searchProviderSkills(catalog.skills, trigger.query).map((skill) => ({
      id: `skill:${provider}:${skill.name}`,
      type: "skill",
      provider,
      skill,
      label: formatProviderSkillDisplayName(skill),
      description:
        skill.shortDescription ??
        skill.description ??
        (skill.scope ? t("{scope} skill", { scope: skill.scope }) : t("Run provider skill")),
    }));
  }
  return [];
}

/** The prompt text a picked command or skill inserts: `/name ` or `$name `. */
export function composerProviderMenuItemText(item: ProviderMenuItem): string {
  return item.type === "skill" ? `$${item.skill.name} ` : `/${item.command.name} `;
}
