import { type KeybindingCommand } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { type ReactNode } from "react";

export const ITEM_ICON_CLASS = "size-4 text-icon-muted";
export const COMMAND_PALETTE_INPUT_PLACEHOLDER = "Search commands...";

export interface CommandPaletteActionItem {
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly shortcutCommand?: KeybindingCommand;
  readonly run: () => Promise<void>;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem>;
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function rankSearchFieldMatch(field: string, normalizedQuery: string): number {
  const normalizedField = normalizeSearchText(field);
  if (normalizedField.length === 0 || !normalizedField.includes(normalizedQuery)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === normalizedQuery) {
    return 3;
  }
  if (normalizedField.startsWith(normalizedQuery)) {
    return 2;
  }
  return 1;
}

function rankCommandPaletteItemMatch(
  item: CommandPaletteActionItem,
  normalizedQuery: string,
): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  for (const [index, field] of terms.entries()) {
    const fieldRank = rankSearchFieldMatch(field, normalizedQuery);
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      return 1_000 - index * 100 + fieldRank;
    }
  }
  return 0;
}

/**
 * Filters each group to the items whose search terms contain the query, ranking
 * earlier and tighter term matches first. A leading ">" is accepted and ignored
 * so the VS Code habit of typing it still works.
 */
export function filterCommandPaletteGroups(input: {
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly query: string;
}): CommandPaletteGroup[] {
  const searchQuery = input.query.startsWith(">") ? input.query.slice(1) : input.query;
  const normalizedQuery = normalizeSearchText(searchQuery);
  if (normalizedQuery.length === 0) {
    return [...input.groups];
  }

  return input.groups.flatMap((group) => {
    const items = Arr.filterMap(group.items, (item, index) => {
      const haystack = normalizeSearchText(item.searchTerms.join(" "));
      if (!haystack.includes(normalizedQuery)) {
        return Result.failVoid;
      }
      return Result.succeed({
        item,
        index,
        rank: rankCommandPaletteItemMatch(item, normalizedQuery),
      });
    })
      .toSorted((left, right) => right.rank - left.rank || left.index - right.index)
      .map((entry) => entry.item);

    return items.length === 0 ? [] : [{ value: group.value, label: group.label, items }];
  });
}
