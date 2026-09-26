import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { BotToolsSheet } from "./BotToolsSheet";

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: unknown) => children,
}));
vi.stubGlobal("document", { body: null });

const render = (canDelegate?: boolean) =>
  renderToStaticMarkup(
    createElement(BotToolsSheet, {
      open: true,
      onOpenChange: () => {},
      servers: [],
      disabledIds: [],
      onDisabledIdsChange: () => {},
      ...(canDelegate === undefined ? {} : { canDelegate }),
    }),
  );

describe("bot tools delegation note", () => {
  it("explains that a legacy provider cannot hand off work", () => {
    expect(render(false)).toContain("This bot&#x27;s provider cannot hand off work.");
  });

  it("stays quiet for providers that can delegate", () => {
    expect(render(true)).not.toContain("cannot hand off work");
    expect(render()).not.toContain("cannot hand off work");
  });
});
