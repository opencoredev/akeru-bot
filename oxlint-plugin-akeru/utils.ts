import * as Predicate from "effect/Predicate";
import type { ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

type ExpressionWrapper =
  | ESTree.ChainExpression
  | ESTree.ParenthesizedExpression
  | ESTree.TSNonNullExpression
  | ESTree.TSAsExpression
  | ESTree.TSTypeAssertion;

type AstNode = ESTree.Node;

const asAstNode = (node: AstNode | null | undefined): Option.Option<AstNode> =>
  Option.fromNullishOr(node);

const isExpressionWrapper = (node: AstNode): node is ExpressionWrapper =>
  node.type === "ChainExpression" ||
  node.type === "ParenthesizedExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSAsExpression" ||
  node.type === "TSTypeAssertion";

export function unwrapExpression(node: AstNode | null | undefined): Option.Option<AstNode> {
  let current = asAstNode(node);

  while (Option.isSome(current) && isExpressionWrapper(current.value)) {
    current = asAstNode(current.value.expression);
  }

  return current;
}

export function getPropertyName(node: AstNode | null | undefined): Option.Option<string> {
  return Option.flatMap(asAstNode(node), (expression) => {
    if (expression.type === "Identifier") {
      return Option.some(expression.name);
    }

    if (expression.type === "PrivateIdentifier") {
      return Option.some(expression.name);
    }

    if (expression.type === "Literal" && Predicate.isString(expression.value)) {
      return Option.some(expression.value);
    }

    return Option.none();
  });
}

export function isIdentifier(node: Option.Option<AstNode>, name?: string): boolean {
  if (Option.isNone(node)) return false;
  const expression = node.value;

  return (
    expression.type === "Identifier" &&
    Predicate.isString(expression.name) &&
    (name === undefined || expression.name === name)
  );
}
