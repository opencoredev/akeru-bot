import type { ServerProviderSkill, ServerProviderSlashCommand } from "@akeru/contracts";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

// One emoji element: a pictograph or symbol with an optional presentation
// selector or skin-tone modifier.
const EMOJI_ELEMENT = String.raw`[\p{Extended_Pictographic}\p{So}](?:\uFE0F|\p{Emoji_Modifier})?`;

// Every drawable icon form: keycaps (1️⃣, #️⃣), regional-indicator flags,
// subdivision tag flags (🏴󠁧󠁢󠁥󠁮󠁧󠁿), and ZWJ sequences of emoji elements. Anything
// else, including bidi and format controls or stray zero-width characters,
// fails the anchored match.
const EMOJI_ICON_PATTERN = new RegExp(
  String.raw`^(?:[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|${EMOJI_ELEMENT}(?:\u200D${EMOJI_ELEMENT})*)$`,
  "u",
);

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function isSingleGrapheme(text: string): boolean {
  if (!graphemeSegmenter) {
    // Engines without Intl.Segmenter (older Hermes) rely on the anchored
    // pattern alone, which already admits only one emoji sequence.
    return true;
  }
  const segments = graphemeSegmenter.segment(text)[Symbol.iterator]();
  return !segments.next().done && segments.next().done === true;
}

/**
 * Returns the skill's own icon when a client can draw it as text: exactly one
 * grapheme that is an emoji or pictographic symbol. Named glyphs ("wrench"),
 * provider asset paths (Codex interface icons live on the environment's disk,
 * out of reach of a remote client), multi-glyph text, and control characters
 * return null, and callers fall back to the source-kind glyph.
 */
export function resolveProviderSkillTextIcon(
  skill: Pick<ServerProviderSkill, "icon">,
): string | null {
  const icon = skill.icon?.replace(/^ +| +$/g, "");
  if (!icon || !EMOJI_ICON_PATTERN.test(icon) || !isSingleGrapheme(icon)) {
    return null;
  }
  return icon;
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu ? skills.filter((skill) => skill.enabled) : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}
