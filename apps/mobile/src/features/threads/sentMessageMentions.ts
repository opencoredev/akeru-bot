import {
  collectComposerInlineTokens,
  collectComposerMentionDisplays,
  type ComposerMentionDisplay,
} from "@akeru/shared/composerInlineTokens";
import { useMemo } from "react";

import type { SelectableMarkdownSkill } from "../../native/SelectableMarkdownText";
import { useBotNames } from "../../state/bots";
import { useThreadTitles } from "../../state/entities";

const NO_SKILLS: ReadonlyArray<SelectableMarkdownSkill> = [];
const NO_IDS = { threadIds: [], botIds: [] } as const;
const MENTION_ICONS = {
  browser: "globe",
  thread: "text.bubble",
  bot: "person.crop.circle",
} as const;
const MARKDOWN_SPECIAL_CHARACTERS = /[\\`*_{}[\]()#+\-.!|<>~]/g;

/** Chips for the `@browser`, `@chat:<id>`, and `@bot:<id>` tokens of a sent message, alongside its skills. */
export function sentMessageMentionSkills(
  displays: ReadonlyArray<ComposerMentionDisplay>,
  skills: ReadonlyArray<SelectableMarkdownSkill>,
): ReadonlyArray<SelectableMarkdownSkill> {
  if (displays.length === 0) return skills;
  return [
    ...skills,
    ...displays.map((display) => ({
      name: display.source,
      displayName: display.label,
      token: display.source,
      icon: MENTION_ICONS[display.kind],
    })),
  ];
}

/**
 * For the plain markdown fallback, which has no inline chips: shows each mention
 * as its bold label. The copy button still copies the raw token.
 */
const MARKDOWN_CODE_SPANS = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;

export function labelSentMessageMentions(
  text: string,
  displays: ReadonlyArray<ComposerMentionDisplay>,
): string {
  // Code keeps its literal text; odd split indexes are the captured code spans.
  return text
    .split(MARKDOWN_CODE_SPANS)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      let labelled = segment;
      for (const display of displays) {
        const label = `**${display.label.replace(MARKDOWN_SPECIAL_CHARACTERS, "\\$&")}**`;
        labelled = labelled
          .split(/(\s+)/)
          .map((part) => (part === display.source ? label : part))
          .join("");
      }
      return labelled;
    })
    .join("");
}

/** Mention chips for a sent message, with chat titles and bot names looked up from the connected environments. */
export function useSentMessageMentions(
  text: string,
  skills: ReadonlyArray<SelectableMarkdownSkill> | undefined,
): {
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly displays: ReadonlyArray<ComposerMentionDisplay>;
} {
  const ids = useMemo(() => {
    if (!text.includes("@")) return NO_IDS;
    const threadIds: string[] = [];
    const botIds: string[] = [];
    for (const token of collectComposerInlineTokens(`${text}\n`)) {
      if (token.type === "thread-mention") threadIds.push(token.value);
      if (token.type === "bot-mention") botIds.push(token.value);
    }
    return { threadIds, botIds };
  }, [text]);
  const titles = useThreadTitles(ids.threadIds);
  const botNames = useBotNames(ids.botIds);
  return useMemo(() => {
    const baseSkills = skills ?? NO_SKILLS;
    if (!text.includes("@")) return { skills: baseSkills, displays: [] };
    const displays = collectComposerMentionDisplays(
      text,
      (threadId) => titles.get(threadId) ?? null,
      (botId) => botNames.get(botId) ?? null,
    );
    return { skills: sentMessageMentionSkills(displays, baseSkills), displays };
  }, [botNames, skills, text, titles]);
}
