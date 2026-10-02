import { Predicate } from "effect";
import { isValidElement, type ReactNode } from "react";

export function nodeToPlainText(node: ReactNode): string {
  if (Predicate.isString(node) || Predicate.isNumber(node)) {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }

  return "";
}
