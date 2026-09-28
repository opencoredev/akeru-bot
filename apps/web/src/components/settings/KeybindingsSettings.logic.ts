import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  parseKeybindingWhenExpression,
} from "@t3tools/shared/keybindings";

import { isMacPlatform } from "../../lib/utils";

export type KeybindingSource = "Default" | "Custom";

export interface KeybindingRow {
  readonly id: string;
  readonly command: KeybindingCommand;
  readonly key: string;
  readonly when: string;
  readonly source: KeybindingSource;
  readonly defaultKey: string | null;
  readonly defaultWhen: string;
  readonly binding: ResolvedKeybindingRule;
  readonly conflicts: ReadonlyArray<string>;
  /** Position in the resolved config. Later bindings win when several match. */
  readonly order: number;
}

export type WhenVariableOption = string;
export type KeybindingCommandOption = KeybindingCommand;

const CORE_WHEN_VARIABLES = ["true", "false"] as const;

const DEFAULT_WHEN_VARIABLES = new Set<string>(CORE_WHEN_VARIABLES);
for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
  collectWhenIdentifiersFromNode(binding.whenAst, DEFAULT_WHEN_VARIABLES);
}

export const DEFAULT_WHEN_VARIABLE =
  [...DEFAULT_WHEN_VARIABLES].find(
    (identifier) => identifier !== "true" && identifier !== "false",
  ) ?? "modelPickerOpen";
const KNOWN_WHEN_VARIABLES = new Set(DEFAULT_WHEN_VARIABLES);

export function shortcutToKeybindingInput(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key);
  return parts.join("+");
}

export function whenAstToExpression(node: KeybindingWhenNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrapWhenExpression(node.node)}`;
    case "and":
      return `${wrapWhenExpression(node.left)} && ${wrapWhenExpression(node.right)}`;
    case "or":
      return `${wrapWhenExpression(node.left)} || ${wrapWhenExpression(node.right)}`;
  }
}

function wrapWhenExpression(node: KeybindingWhenNode): string {
  if (node.type === "identifier" || node.type === "not") return whenAstToExpression(node);
  return `(${whenAstToExpression(node)})`;
}

export function parseWhenExpressionDraft(
  expression: string,
): { ok: true; value: KeybindingWhenNode | undefined } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };

  const ast = parseKeybindingWhenExpression(trimmed);
  if (!ast) {
    return {
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    };
  }

  return { ok: true, value: ast };
}

function sourceForBinding(binding: ResolvedKeybindingRule): KeybindingSource {
  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);
  const isDefault = DEFAULT_RESOLVED_KEYBINDINGS.some(
    (entry) =>
      entry.command === binding.command &&
      shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
      whenAstToExpression(entry.whenAst) === bindingWhen,
  );

  return isDefault ? "Default" : "Custom";
}

function defaultBindingForBinding(
  binding: ResolvedKeybindingRule,
): ResolvedKeybindingRule | undefined {
  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);

  return (
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command &&
        shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
        whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command && whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find((entry) => entry.command === binding.command)
  );
}

function keybindingRowId(command: KeybindingCommand, key: string, when: string): string {
  return `${command}\u0000${key}\u0000${when}`;
}

interface ConflictProbe {
  readonly when: string;
  readonly order: number;
}

// The resolver runs the last matching binding. A scoped binding defined after
// an unscoped one on the same keys is a deliberate override (the model picker
// reusing mod+1 while it is open). The reverse leaves the scoped one dead.
function bindingsConflict(left: ConflictProbe, right: ConflictProbe): boolean {
  if (left.when === right.when) return true;
  if (left.when.length > 0 && right.when.length > 0) return false;
  const scoped = left.when.length > 0 ? left : right;
  const unscoped = scoped === left ? right : left;
  return unscoped.order > scoped.order;
}

/**
 * Commands whose binding collides with `input`. Drafts omit `order` because
 * saving appends them after every existing binding.
 */
export function keybindingConflictLabels(
  rows: ReadonlyArray<KeybindingRow>,
  input: {
    readonly rowId: string;
    readonly key: string;
    readonly when: string;
    readonly order?: number;
  },
): ReadonlyArray<string> {
  if (input.key.trim().length === 0) return [];
  const probe = { when: input.when, order: input.order ?? Number.POSITIVE_INFINITY };
  const conflicts: Array<string> = [];
  for (const candidate of rows) {
    if (
      candidate.id !== input.rowId &&
      candidate.key === input.key &&
      bindingsConflict(candidate, probe)
    ) {
      conflicts.push(commandLabel(candidate.command));
    }
  }
  return [...new Set(conflicts)].toSorted();
}

export function buildKeybindingRows(
  keybindings: ResolvedKeybindingsConfig,
  query: string,
): ReadonlyArray<KeybindingRow> {
  const normalizedQuery = query.trim().toLowerCase();
  const rows = keybindings.flatMap((binding, index) => {
    if (isRetiredCommand(binding.command)) return [];
    const defaultBinding = defaultBindingForBinding(binding);
    const key = shortcutToKeybindingInput(binding.shortcut);
    const when = whenAstToExpression(binding.whenAst);
    return {
      id: `${keybindingRowId(binding.command, key, when)}\u0000${index}`,
      command: binding.command,
      key,
      when,
      source: sourceForBinding(binding),
      defaultKey: defaultBinding ? shortcutToKeybindingInput(defaultBinding.shortcut) : null,
      defaultWhen: whenAstToExpression(defaultBinding?.whenAst),
      binding,
      conflicts: [],
      order: index,
    } satisfies KeybindingRow;
  });

  const rowsWithConflicts = rows.map((row) => {
    const conflicts = keybindingConflictLabels(rows, {
      rowId: row.id,
      key: row.key,
      when: row.when,
      order: row.order,
    });
    return conflicts.length > 0
      ? Object.assign({}, row, { conflicts: [...new Set(conflicts)].toSorted() })
      : row;
  });

  rowsWithConflicts.sort((left, right) => {
    const commandCompare = left.command.localeCompare(right.command);
    if (commandCompare !== 0) return commandCompare;
    return left.key.localeCompare(right.key);
  });

  if (normalizedQuery.length === 0) {
    return rowsWithConflicts;
  }

  return rowsWithConflicts.filter((row) => {
    return (
      row.command.toLowerCase().includes(normalizedQuery) ||
      commandLabel(row.command).toLowerCase().includes(normalizedQuery) ||
      keybindingGroupTitle(keybindingGroupForCommand(row.command))
        .toLowerCase()
        .includes(normalizedQuery) ||
      row.key.toLowerCase().includes(normalizedQuery) ||
      row.when.toLowerCase().includes(normalizedQuery) ||
      row.source.toLowerCase().includes(normalizedQuery)
    );
  });
}

export type KeybindingGroupId = "general" | "chats" | "composer" | "layout";

export const KEYBINDING_GROUPS: ReadonlyArray<{
  readonly id: KeybindingGroupId;
  readonly title: string;
}> = [
  { id: "general", title: "General" },
  { id: "chats", title: "Chats" },
  { id: "composer", title: "Composer & models" },
  { id: "layout", title: "Layout" },
];

// Display order within each group follows this list. Commands missing here
// (future additions) land at the end of General with a generated title.
const COMMAND_META: ReadonlyArray<readonly [string, string, KeybindingGroupId]> = [
  ["commandPalette.toggle", "Open command palette", "general"],
  ["themeEditor.toggle", "Toggle theme editor", "general"],
  ["chat.new", "New chat", "chats"],
  ["chat.newLocal", "New local chat", "chats"],
  ["thread.previous", "Previous chat", "chats"],
  ["thread.next", "Next chat", "chats"],
  ["thread.jump", "Jump to chat", "chats"],
  ["thread.settle", "Settle chat", "chats"],
  ["composer.stash", "Stash draft", "composer"],
  ["modelPicker.toggle", "Open model picker", "composer"],
  ["modelPicker.jump", "Pick model", "composer"],
  ["sidebar.toggle", "Toggle sidebar", "layout"],
  ["rightPanel.toggle", "Toggle right panel", "layout"],
];

const COMMAND_META_BY_ID = new Map(
  COMMAND_META.map(([id, title, group], order) => [id, { title, group, order }] as const),
);

// Numbered commands (thread.jump.1 … thread.jump.9) share one meta entry and
// collapse into a single series row in the settings list.
const SERIES_COMMAND_PATTERN = /^(thread\.jump|modelPicker\.jump)\.(\d+)$/;

function seriesParts(command: KeybindingCommand): { id: string; index: number } | null {
  const match = SERIES_COMMAND_PATTERN.exec(String(command));
  if (!match?.[1] || !match[2]) return null;
  return { id: match[1], index: Number(match[2]) };
}

/**
 * Commands for surfaces Akeru no longer has: the terminal drawer, diff panel,
 * file browser, project scripts, and preview-panel shortcuts. They still decode
 * from older keybindings files, but nothing handles them, so settings hides them.
 */
const RETIRED_COMMAND_PREFIXES = ["terminal.", "diff.", "preview.", "script."] as const;
const RETIRED_COMMANDS = new Set([
  "filePicker.toggle",
  "projectSearch.toggle",
  "editor.openFavorite",
  "rightPanel.toggleMaximized",
]);

export function isRetiredCommand(command: KeybindingCommand): boolean {
  const raw = String(command);
  return (
    RETIRED_COMMANDS.has(raw) || RETIRED_COMMAND_PREFIXES.some((prefix) => raw.startsWith(prefix))
  );
}

export function keybindingGroupForCommand(command: KeybindingCommand): KeybindingGroupId {
  const series = seriesParts(command);
  return COMMAND_META_BY_ID.get(series?.id ?? String(command))?.group ?? "general";
}

export function keybindingGroupTitle(groupId: KeybindingGroupId): string {
  return KEYBINDING_GROUPS.find((group) => group.id === groupId)?.title ?? "General";
}

function commandOrder(command: KeybindingCommand): number {
  const series = seriesParts(command);
  const meta = COMMAND_META_BY_ID.get(series?.id ?? String(command));
  if (!meta) return Number.MAX_SAFE_INTEGER;
  return meta.order + (series ? series.index / 100 : 0);
}

export type KeybindingFilter = "all" | "customized" | "conflicts";

export function matchesKeybindingFilter(row: KeybindingRow, filter: KeybindingFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "customized":
      return row.source === "Custom";
    case "conflicts":
      return row.conflicts.length > 0;
  }
}

export interface KeybindingSummary {
  readonly total: number;
  readonly customized: number;
  readonly conflicts: number;
}

export function summarizeKeybindings(rows: ReadonlyArray<KeybindingRow>): KeybindingSummary {
  let customized = 0;
  let conflicts = 0;
  for (const row of rows) {
    if (row.source === "Custom") customized += 1;
    if (row.conflicts.length > 0) conflicts += 1;
  }
  return { total: rows.length, customized, conflicts };
}

export interface KeybindingSeries {
  readonly id: string;
  readonly title: string;
  readonly rows: ReadonlyArray<KeybindingRow>;
  /** Compact shortcut such as `mod+1–9` when every step follows the same pattern. */
  readonly rangeKey: string | null;
  /** Shared when expression, or `null` when the steps differ. */
  readonly when: string | null;
}

export type KeybindingListItem =
  | { readonly type: "row"; readonly row: KeybindingRow }
  | { readonly type: "series"; readonly series: KeybindingSeries };

export interface KeybindingGroupView {
  readonly id: KeybindingGroupId;
  readonly title: string;
  readonly items: ReadonlyArray<KeybindingListItem>;
  readonly rowCount: number;
}

function buildSeries(id: string, rows: ReadonlyArray<KeybindingRow>): KeybindingSeries {
  const indices = rows.map((row) => seriesParts(row.command)?.index ?? 0);
  const min = Math.min(...indices);
  const max = Math.max(...indices);
  const firstRow = rows[0];
  const baseTitle = COMMAND_META_BY_ID.get(id)?.title ?? id;
  const firstWhen = firstRow?.when ?? "";
  const when = rows.every((row) => row.when === firstWhen) ? firstWhen : null;

  let rangeKey: string | null = null;
  if (firstRow && when !== null) {
    const prefix = firstRow.key.slice(0, firstRow.key.lastIndexOf("+") + 1);
    const followsPattern =
      prefix.length > 0 &&
      new Set(indices).size === rows.length &&
      max - min + 1 === rows.length &&
      rows.every((row, index) => row.key === `${prefix}${indices[index]}`);
    if (followsPattern) rangeKey = `${prefix}${min}–${max}`;
  }

  return {
    id,
    title: min === max ? `${baseTitle} ${min}` : `${baseTitle} ${min}–${max}`,
    rows,
    rangeKey,
    when,
  };
}

/**
 * Groups rows by purpose for the settings list. Numbered command series with
 * more than one visible row collapse into a single series item.
 */
export function buildKeybindingGroups(
  rows: ReadonlyArray<KeybindingRow>,
  filter: KeybindingFilter = "all",
): ReadonlyArray<KeybindingGroupView> {
  const byGroup = new Map<KeybindingGroupId, KeybindingRow[]>();
  for (const row of rows) {
    if (!matchesKeybindingFilter(row, filter)) continue;
    const groupId = keybindingGroupForCommand(row.command);
    const groupRows = byGroup.get(groupId) ?? [];
    groupRows.push(row);
    byGroup.set(groupId, groupRows);
  }

  const groups: KeybindingGroupView[] = [];
  for (const group of KEYBINDING_GROUPS) {
    const groupRows = byGroup.get(group.id);
    if (!groupRows || groupRows.length === 0) continue;
    groupRows.sort((left, right) => {
      const orderCompare = commandOrder(left.command) - commandOrder(right.command);
      if (orderCompare !== 0) return orderCompare;
      const labelCompare = commandLabel(left.command).localeCompare(commandLabel(right.command));
      if (labelCompare !== 0) return labelCompare;
      return left.key.localeCompare(right.key);
    });

    const seriesRows = new Map<string, KeybindingRow[]>();
    for (const row of groupRows) {
      const series = seriesParts(row.command);
      if (!series) continue;
      const members = seriesRows.get(series.id) ?? [];
      members.push(row);
      seriesRows.set(series.id, members);
    }

    const items: KeybindingListItem[] = [];
    const emittedSeries = new Set<string>();
    for (const row of groupRows) {
      const series = seriesParts(row.command);
      const members = series ? seriesRows.get(series.id) : undefined;
      if (!series || !members || members.length < 2) {
        items.push({ type: "row", row });
        continue;
      }
      if (emittedSeries.has(series.id)) continue;
      emittedSeries.add(series.id);
      items.push({ type: "series", series: buildSeries(series.id, members) });
    }

    groups.push({ id: group.id, title: group.title, items, rowCount: groupRows.length });
  }
  return groups;
}

const WHEN_VARIABLE_PHRASES: Readonly<Record<string, string>> = {
  previewFocus: "the preview is focused",
  modelPickerOpen: "the model picker is open",
};

/**
 * Plain-language summary of a when clause. Returns `null` when there is no
 * condition, and the raw expression when it is too complex to paraphrase.
 */
export function describeWhenExpression(node: KeybindingWhenNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier") {
    if (node.name === "true") return "Always";
    if (node.name === "false") return "Never";
    const phrase = WHEN_VARIABLE_PHRASES[node.name];
    return phrase ? `When ${phrase}` : `When ${node.name}`;
  }
  if (node.type === "not" && node.node.type === "identifier") {
    const phrase = WHEN_VARIABLE_PHRASES[node.node.name];
    return phrase ? `Unless ${phrase}` : `Unless ${node.node.name}`;
  }
  return whenAstToExpression(node);
}

const MAC_MODIFIER_ORDER = ["ctrl", "alt", "shift", "mod", "meta"] as const;
const OTHER_MODIFIER_ORDER = ["mod", "ctrl", "meta", "alt", "shift"] as const;

function modifierLabel(modifier: string, isMac: boolean): string {
  switch (modifier) {
    case "mod":
      return isMac ? "⌘" : "Ctrl";
    case "meta":
      return isMac ? "⌘" : "Meta";
    case "ctrl":
      return isMac ? "⌃" : "Ctrl";
    case "alt":
      return isMac ? "⌥" : "Alt";
    case "shift":
      return isMac ? "⇧" : "Shift";
    default:
      return modifier;
  }
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  space: "Space",
  esc: "Esc",
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "Page Up",
  pagedown: "Page Down",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/**
 * Splits a keybinding string such as `mod+shift+k` into the labels shown on
 * separate key caps, in the platform's conventional modifier order.
 */
export function keybindingDisplayParts(value: string, platform: string): ReadonlyArray<string> {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return [];
  const endsWithPlusKey = trimmed.endsWith("+") && trimmed.length > 1;
  const tokens = (endsWithPlusKey ? trimmed.slice(0, -1) : trimmed)
    .split("+")
    .filter((token) => token.length > 0);
  if (endsWithPlusKey) tokens.push("+");

  const isMac = isMacPlatform(platform);
  const modifierOrder: ReadonlyArray<string> = isMac ? MAC_MODIFIER_ORDER : OTHER_MODIFIER_ORDER;
  const modifiers = tokens.filter((token) => modifierOrder.includes(token));
  const keys = tokens.filter((token) => !modifierOrder.includes(token));
  modifiers.sort((left, right) => modifierOrder.indexOf(left) - modifierOrder.indexOf(right));

  // `mod` and `meta` both read as ⌘ on macOS, so labels are deduplicated.
  return [
    ...new Set([
      ...modifiers.map((modifier) => modifierLabel(modifier, isMac)),
      ...keys.map((key) => KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key)),
    ]),
  ];
}

function collectWhenIdentifiersFromNode(
  node: KeybindingWhenNode | undefined,
  identifiers: Set<string>,
): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
      identifiers.add(node.name);
      return;
    case "not":
      collectWhenIdentifiersFromNode(node.node, identifiers);
      return;
    case "and":
    case "or":
      collectWhenIdentifiersFromNode(node.left, identifiers);
      collectWhenIdentifiersFromNode(node.right, identifiers);
      return;
  }
}

export function isKnownWhenVariable(identifier: string): boolean {
  return KNOWN_WHEN_VARIABLES.has(identifier);
}

export function unknownWhenVariables(node: KeybindingWhenNode | undefined): ReadonlyArray<string> {
  const identifiers = new Set<string>();
  collectWhenIdentifiersFromNode(node, identifiers);
  return [...identifiers].filter((identifier) => !isKnownWhenVariable(identifier)).toSorted();
}

export function buildWhenVariableOptions(): ReadonlyArray<WhenVariableOption> {
  return [...KNOWN_WHEN_VARIABLES].toSorted((left, right) => {
    const leftCoreIndex = CORE_WHEN_VARIABLES.indexOf(left as (typeof CORE_WHEN_VARIABLES)[number]);
    const rightCoreIndex = CORE_WHEN_VARIABLES.indexOf(
      right as (typeof CORE_WHEN_VARIABLES)[number],
    );
    if (leftCoreIndex !== -1 || rightCoreIndex !== -1) {
      return (
        (leftCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : leftCoreIndex) -
        (rightCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : rightCoreIndex)
      );
    }
    return left.localeCompare(right);
  });
}

export function buildKeybindingCommandOptions(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<KeybindingCommandOption> {
  // Offer commands that still ship a default, plus whatever the user already
  // binds. Retired commands stay valid in the contract for old files only.
  const commands = new Set<KeybindingCommand>(
    DEFAULT_RESOLVED_KEYBINDINGS.map((binding) => binding.command),
  );
  for (const binding of keybindings) {
    if (!isRetiredCommand(binding.command)) commands.add(binding.command);
  }
  return [...commands].toSorted((left, right) =>
    commandLabel(left).localeCompare(commandLabel(right)),
  );
}

export function commandLabel(command: KeybindingCommand): string {
  const raw = String(command);
  const series = seriesParts(command);
  if (series) {
    const title = COMMAND_META_BY_ID.get(series.id)?.title;
    if (title) return `${title} ${series.index}`;
  }
  const title = COMMAND_META_BY_ID.get(raw)?.title;
  if (title) return title;
  return raw.split(".").map(titleCaseCommandSegment).join(": ");
}

function titleCaseCommandSegment(segment: string): string {
  const words: Array<string> = [];
  for (const part of segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_\s]+/)) {
    if (part.length > 0) {
      words.push(part.slice(0, 1).toUpperCase() + part.slice(1));
    }
  }
  return words.join(" ");
}

export function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (/^f\d{1,2}$/.test(normalized)) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

export function keybindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: string,
): string | null {
  const keyToken = normalizeShortcutKeyToken(event.key);
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (parts.length === 0) {
    return null;
  }
  parts.push(keyToken);
  return parts.join("+");
}
