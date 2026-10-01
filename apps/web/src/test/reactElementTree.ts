import { isValidElement, type ReactElement } from "react";

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- React props may contain any runtime value; isValidElement narrows the node before props are visited.
type ReactTreeProps = Record<string, unknown>;

/**
 * Depth-first search over a React element tree produced by calling a component
 * as a plain function (see `reactHookHarness`). Descends through props so
 * render-prop and slot-style children are reachable. Returns the first element
 * the visitor accepts, or null.
 */
export function visitElements(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This runtime tree walker probes arbitrary React prop values, including non-element objects.
  node: unknown,
  visitor: (element: ReactElement<ReactTreeProps>) => boolean,
): ReactElement<ReactTreeProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = visitElements(child, visitor);

      if (found) return found;
    }

    return null;
  }

  if (!isValidElement<ReactTreeProps>(node)) return null;

  if (visitor(node)) return node;

  for (const value of Object.values(node.props)) {
    const found = visitElements(value, visitor);

    if (found) return found;
  }

  return null;
}
