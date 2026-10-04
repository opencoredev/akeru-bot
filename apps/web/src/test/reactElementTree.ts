import { isValidElement, type AllHTMLAttributes, type ReactElement, type ReactNode } from "react";

/** The DOM attributes tests read from a found element; other props are walked, not read. */
type ReactTreeProps = AllHTMLAttributes<HTMLElement>;

/** Anything worth descending into: rendered content, or an array that may hold elements. */
type ReactTreeNode = ReactNode | ReadonlyArray<unknown>;

function isElementList(value: ReactTreeNode): value is ReadonlyArray<unknown> {
  return Array.isArray(value);
}

/** Props hold handlers and data too; only elements and arrays can contain more elements. */
function isReactTreeBranch(value: unknown): value is ReactElement | ReadonlyArray<unknown> {
  return Array.isArray(value) || isValidElement(value);
}

/**
 * Depth-first search over a React element tree produced by calling a component
 * as a plain function (see `reactHookHarness`). Descends through props so
 * render-prop and slot-style children are reachable. Returns the first element
 * the visitor accepts, or null.
 */
export function visitElements(
  node: ReactTreeNode,
  visitor: (element: ReactElement<ReactTreeProps>) => boolean,
): ReactElement<ReactTreeProps> | null {
  if (isElementList(node)) {
    for (const child of node.filter(isReactTreeBranch)) {
      const found = visitElements(child, visitor);

      if (found) return found;
    }

    return null;
  }

  if (!isValidElement<ReactTreeProps>(node)) return null;

  if (visitor(node)) return node;

  for (const value of Object.values(node.props).filter(isReactTreeBranch)) {
    const found = visitElements(value, visitor);

    if (found) return found;
  }

  return null;
}
