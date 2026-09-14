import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadRuntimeWarningBanner } from "./ThreadRuntimeWarningBanner";

describe("ThreadRuntimeWarningBanner", () => {
  it("renders the warning as an accessible status", () => {
    const markup = renderToStaticMarkup(
      <ThreadRuntimeWarningBanner warning="Claude is paused until the usage window resets." />,
    );

    expect(markup).toContain('data-testid="thread-runtime-warning"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Claude is paused until the usage window resets.");
  });

  it("renders nothing without an active warning", () => {
    expect(renderToStaticMarkup(<ThreadRuntimeWarningBanner warning={null} />)).toBe("");
  });
});
