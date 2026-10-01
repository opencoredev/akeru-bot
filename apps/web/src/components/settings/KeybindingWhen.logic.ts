import type { KeybindingWhenNode } from "@akeru/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  parseKeybindingWhenExpression,
} from "@akeru/shared/keybindings";

export type WhenVariableOption = string;

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
    const leftCoreIndex = CORE_WHEN_VARIABLES.findIndex((identifier) => identifier === left);
    const rightCoreIndex = CORE_WHEN_VARIABLES.findIndex((identifier) => identifier === right);

    if (leftCoreIndex !== -1 || rightCoreIndex !== -1) {
      return (
        (leftCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : leftCoreIndex) -
        (rightCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : rightCoreIndex)
      );
    }

    return left.localeCompare(right);
  });
}
