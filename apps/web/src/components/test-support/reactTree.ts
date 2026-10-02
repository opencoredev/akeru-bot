import { isValidElement, type ReactElement, type ReactNode } from "react";

/** Values stored in props by the component fixtures, including callbacks and render slots. */
export type TestValue = ReactNode | TestProps | TestCallback | readonly TestValue[];

export type TestCallback = (...args: never[]) => TestValue | void | Promise<TestValue | void>;

export interface TestProps {
  readonly [name: string]: TestValue;
}

export type TestElement = ReactElement<TestProps>;

export function visitElements(
  node: TestValue,
  visitor: (element: TestElement) => boolean,
): TestElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = visitElements(child, visitor);

      if (found) return found;
    }

    return null;
  }

  if (!isValidElement<TestProps>(node)) return null;

  if (visitor(node)) return node;

  for (const value of Object.values(node.props)) {
    const found = visitElements(value, visitor);

    if (found) return found;
  }

  return null;
}
