import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SettingsPanelForSection } from "./SettingsDialog";

// The page container reads the hash for deep links; no router is mounted here.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: ({ select }: { select: (location: { hash: string }) => unknown }) =>
    select({ hash: "" }),
  useNavigate: () => () => undefined,
  Link: ({ to, children, className }: { to: string; children: unknown; className?: string }) => (
    <a href={to} className={className}>
      {children as never}
    </a>
  ),
}));

describe("settings section loading", () => {
  it("renders General on first paint instead of a loading fallback", () => {
    // Static rendering never waits on a lazy chunk, so a suspended page shows the spinner.
    const markup = renderToStaticMarkup(<SettingsPanelForSection section="general" />);

    expect(markup).toContain("Preferences");
    expect(markup).toContain('id="time-format"');
    expect(markup).toContain("Send feedback");
    expect(markup).not.toContain('role="status"');
  });

  it("still loads other pages on demand", () => {
    const markup = renderToStaticMarkup(<SettingsPanelForSection section="appearance" />);

    expect(markup).toContain('role="status"');
  });
});
