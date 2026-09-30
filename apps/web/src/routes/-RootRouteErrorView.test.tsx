import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { Button } from "../components/ui/button";
import { errorDetails, errorMessage, RootRouteErrorView } from "./-RootRouteErrorView";

interface ActionElementProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
}

function findButtons(node: ReactNode): ReactElement<ActionElementProps>[] {
  if (!isValidElement<ActionElementProps>(node)) return [];
  const match = node.type === Button ? [node] : [];
  return [...match, ...Children.toArray(node.props.children).flatMap(findButtons)];
}

describe("RootRouteErrorView", () => {
  it("puts recovery guidance before the technical error", () => {
    const markup = renderToStaticMarkup(
      <RootRouteErrorView
        error={new TypeError("bots.filter is not a function")}
        reload={() => {}}
        reset={() => {}}
      />,
    );

    expect(markup).toContain('aria-labelledby="root-error-title"');
    expect(markup).toContain("<h1");
    expect(markup).toContain("This view failed to load");
    expect(markup).toContain("Retry this view. If it fails again, reload Akeru Bot.");
    expect(markup).toContain("bots.filter is not a function");
    expect(markup).toContain("Technical details");
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("AlertCircle");
    expect(markup).not.toContain("background-size:64px");
    expect(markup.indexOf("Retry this view")).toBeLessThan(markup.indexOf("Technical details"));
  });

  it("offers retry and full reload as separate recovery actions", () => {
    const reset = vi.fn();
    const reload = vi.fn();
    const view = RootRouteErrorView({ error: new Error("Failed to load"), reload, reset });
    const [retryButton, reloadButton] = findButtons(view);

    expect(Children.toArray(retryButton?.props.children)).toContain("Retry");
    expect(Children.toArray(reloadButton?.props.children)).toContain("Reload app");

    retryButton?.props.onClick?.();
    reloadButton?.props.onClick?.();

    expect(reset).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("provides useful fallbacks for unknown and unserializable errors", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("failed to connect")).toBe("failed to connect");
    expect(errorMessage("   ")).toBe("An unexpected error stopped this view from loading.");
    expect(errorDetails("failed to connect")).toBe("failed to connect");
    expect(errorDetails(circular)).toBe("No additional error details are available.");
  });
});
