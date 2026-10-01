import type { TestProps, TestValue } from "../test-support/reactTree";
// @effect-diagnostics nodeBuiltinImport:off - Source contracts read the settings modules.
import * as NodeFS from "node:fs";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

import { BotEngineFields } from "./BotEngineFields";
import { BotIdentityFields } from "./BotIdentityFields";

type Tree = ReactElement<TestProps>;

/** Source of every module that renders part of the bot settings page. */
export function readBotSettingsSource(): string {
  return [
    "./BotSettingsPage.tsx",
    "./BotSettingsForm.tsx",
    "./BotIdentityFields.tsx",
    "./BotEngineFields.tsx",
  ]
    .map((path) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
}

function expand(node: TestValue): TestValue {
  if (Array.isArray(node)) {
    return node.some((child) => Array.isArray(child) || isValidElement(child))
      ? node.map(expand)
      : node;
  }

  if (!isValidElement<TestProps>(node)) return node;

  if (
    node.type === BotIdentityFields &&
    isValidElement<Parameters<typeof BotIdentityFields>[0]>(node)
  ) {
    // SAFETY: the element was created from BotIdentityFields, so its props match.
    return expand(BotIdentityFields(node.props));
  }

  if (
    node.type === BotEngineFields &&
    isValidElement<Parameters<typeof BotEngineFields>[0]>(node)
  ) {
    // SAFETY: the element was created from BotEngineFields, so its props match.
    return expand(BotEngineFields(node.props));
  }

  const props = Object.fromEntries(
    Object.entries(node.props).map(([key, value]) => [key, expand(value)]),
  );

  return cloneElement(node, props);
}

/**
 * Renders the form's section leaves in place, the way React would within the same pass, so
 * a test can reach the controls inside them.
 */
export function expandBotSettingsSections(tree: ReactNode): Tree {
  // SAFETY: expanding a form tree keeps its root element.
  return expand(tree) as Tree;
}
