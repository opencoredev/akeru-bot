/**
 * Keybindings - Keybinding configuration service definitions.
 *
 * Owns parsing, validation, merge, and persistence of user keybinding
 * configuration consumed by the server runtime.
 *
 * @module Keybindings
 */
import { KeybindingRule, KeybindingsConfig, MAX_KEYBINDINGS_COUNT, ResolvedKeybindingsConfig, type ServerConfigIssue } from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { fromJsonStringPretty, fromLenientJson } from "@akeru/shared/schemaJson";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@akeru/shared/keybindings";

import { ResolvedKeybindingFromConfig } from "./keybindingRules.ts";

/**
 * Exact former defaults that startup removes without touching user overrides.
 * The commands stay in the contract so older keybindings.json files still decode.
 */
export const RETIRED_DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+shift+d", command: "terminal.splitVertical", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+f", command: "projectSearch.toggle", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "mod+o", command: "editor.openFavorite" },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  { key: "mod+shift+s", command: "thread.settle", when: "!terminalFocus" },
  { key: "mod+shift+j", command: "preview.toggle" },
  { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
  { key: "mod+l", command: "preview.focusUrl", when: "previewFocus" },
  { key: "mod+=", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod++", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod+-", command: "preview.zoomOut", when: "previewFocus" },
  { key: "mod+0", command: "preview.resetZoom", when: "previewFocus" },
  // Replaced by the same shortcut without the retired terminal condition.
  { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
  { key: "mod+s", command: "composer.stash", when: "!terminalFocus" },
];

export const RawKeybindingsEntries = fromLenientJson(Schema.Array(Schema.Unknown));

export const KeybindingsConfigPrettyJson = fromJsonStringPretty(KeybindingsConfig);

export const decodeKeybindingRuleExit = Schema.decodeUnknownExit(KeybindingRule);

export const decodeResolvedKeybindingFromConfigExit = Schema.decodeExit(ResolvedKeybindingFromConfig);

export const decodeRawKeybindingsEntriesExit = Schema.decodeUnknownExit(RawKeybindingsEntries);

export const encodeKeybindingsConfigPrettyJson = Schema.encodeEffect(KeybindingsConfigPrettyJson);

export interface KeybindingsConfigState {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

export interface KeybindingsChangeEvent {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

export function trimIssueMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "Invalid keybindings configuration.";
}

export function malformedConfigIssue(detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.malformed-config",
    message: trimIssueMessage(detail),
  };
}

export function invalidEntryIssue(index: number, detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.invalid-entry",
    index,
    message: trimIssueMessage(detail),
  };
}

export function mergeWithDefaultKeybindings(custom: ResolvedKeybindingsConfig): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= MAX_KEYBINDINGS_COUNT) {
    return merged;
  }

  // Keep the latest rules when the config exceeds max size; later rules have higher precedence.
  return merged.slice(-MAX_KEYBINDINGS_COUNT);
}
