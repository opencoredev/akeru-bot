import type { ProjectEntry, ServerProvider } from "@akeru/contracts";
import type { ComposerTrigger } from "@akeru/shared/composerTrigger";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@akeru/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

/**
 * Items for the composer's `/`, `$`, and `@` path menus at the current trigger.
 * Skills rank by name, label, then description; the list is capped at 20.
 */
export function buildComposerCommandItems(
  trigger: ComposerTrigger | null,
  pathEntries: ReadonlyArray<ProjectEntry>,
  providerStatus: ServerProvider | null,
): ComposerCommandItem[] {
  if (!trigger) return [];

  if (trigger.kind === "slash-command") {
    const q = trigger.query.toLowerCase();
    const allBuiltIn = [
      {
        id: "cmd:model",
        type: "slash-command" as const,
        command: "model",
        label: "/model",
        description: "Switch model",
      },
    ];
    const builtIn = allBuiltIn.filter((item) => item.command.includes(q));

    const providerCommands: ComposerCommandItem[] = [];
    for (const cmd of providerStatus?.slashCommands ?? []) {
      if (!cmd.name.toLowerCase().includes(q)) continue;
      providerCommands.push({
        id: `pcmd:${cmd.name}`,
        type: "provider-slash-command" as const,
        command: cmd,
        label: `/${cmd.name}`,
        description: cmd.description ?? "",
      });
    }

    const skillItems = (providerStatus?.skills ?? [])
      .filter((skill) => matchesSlashSkillQuery(skill, q))
      .map((skill) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        skill,
        label: `skill:${skill.name}`,
        description: skill.shortDescription ?? skill.description ?? "",
      }));

    return [...builtIn, ...providerCommands, ...skillItems];
  }

  if (trigger.kind === "skill") {
    const enabledSkills = (providerStatus?.skills ?? []).filter((s) => s.enabled);
    const normalizedQuery = normalizeSearchQuery(trigger.query, {
      trimLeadingPattern: /^\$+/,
    });

    if (!normalizedQuery) {
      return enabledSkills.slice(0, 20).map((skill) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        skill,
        label: skill.displayName ?? skill.name,
        description: skill.shortDescription ?? skill.description ?? "",
      }));
    }

    const ranked: Array<{
      item: (typeof enabledSkills)[number];
      score: number;
      tieBreaker: string;
    }> = [];
    for (const skill of enabledSkills) {
      const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
      const scores = [
        scoreQueryMatch({
          value: skill.name.toLowerCase(),
          query: normalizedQuery,
          exactBase: 0,
          prefixBase: 2,
          boundaryBase: 4,
          includesBase: 6,
          fuzzyBase: 100,
          boundaryMarkers: ["-", "_", "/"],
        }),
        scoreQueryMatch({
          value: displayLabel,
          query: normalizedQuery,
          exactBase: 1,
          prefixBase: 3,
          boundaryBase: 5,
          includesBase: 7,
          fuzzyBase: 110,
        }),
        scoreQueryMatch({
          value: skill.shortDescription?.toLowerCase() ?? "",
          query: normalizedQuery,
          exactBase: 20,
          prefixBase: 22,
          boundaryBase: 24,
          includesBase: 26,
        }),
        scoreQueryMatch({
          value: skill.description?.toLowerCase() ?? "",
          query: normalizedQuery,
          exactBase: 30,
          prefixBase: 32,
          boundaryBase: 34,
          includesBase: 36,
        }),
      ].filter((s): s is number => s !== null);

      if (scores.length > 0) {
        insertRankedSearchResult(
          ranked,
          {
            item: skill,
            score: Math.min(...scores),
            tieBreaker: `${displayLabel}\u0000${skill.name}`,
          },
          20,
        );
      }
    }

    return ranked.map(({ item: skill }) => ({
      id: `skill:${skill.name}`,
      type: "skill" as const,
      skill,
      label: skill.displayName ?? skill.name,
      description: skill.shortDescription ?? skill.description ?? "",
    }));
  }

  if (trigger.kind === "path") {
    const fileItems = pathEntries.map((entry) => {
      const parts = entry.path.split("/");
      return {
        id: `path:${entry.path}`,
        type: "path" as const,
        path: entry.path,
        kind: entry.kind,
        label: parts[parts.length - 1] ?? entry.path,
        description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
      };
    });
    return fileItems;
  }

  return [];
}
