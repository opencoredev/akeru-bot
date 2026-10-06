import { CloudEnvironmentId, EnvironmentId, type CloudLinkStatus } from "@akeru/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environmentId: "env-test" as string | null,
  status: null as CloudLinkStatus | null,
  error: null as string | null,
}));

vi.mock("../../settingsDialogStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settingsDialogStore")>()),
  useSettingsEnvironmentId: () => state.environmentId,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.status, error: state.error }),
}));

vi.mock("../../state/server", () => ({ serverEnvironment: { cloudStatus: () => null } }));

vi.mock("./useCloudLinkCommands", () => ({
  useCloudLinkCommands: () => ({ connect: vi.fn(), cancel: vi.fn(), disconnect: vi.fn() }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: <T,>({ select }: { select: (location: { hash: string }) => T }) =>
    select({ hash: "" }),
  useNavigate: () => vi.fn(),
}));

import { AkeruCloudSettingsPanel } from "./AkeruCloudSettings";

const render = (status: CloudLinkStatus | null) => {
  state.environmentId = EnvironmentId.make("env-test");
  state.status = status;
  state.error = null;

  return renderToStaticMarkup(<AkeruCloudSettingsPanel />);
};

describe("Akeru Cloud settings", () => {
  it("offers an optional connection and explains an absent environment", () => {
    expect(render({ status: "unlinked" })).toContain("Connect Akeru Cloud");
    state.environmentId = null;
    expect(renderToStaticMarkup(<AkeruCloudSettingsPanel />)).toContain("Connect an environment");
  });

  it("shows the approval code, browser destination, and cancellation", () => {
    const markup = render({
      status: "linking",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://cloud.example/link?code=ABCD-EFGH",
      expiresAt: "2026-10-05T00:00:00Z",
    });

    expect(markup).toContain("ABCD-EFGH");
    expect(markup).toContain('href="https://cloud.example/link?code=ABCD-EFGH"');
    expect(markup).toContain("Cancel");
  });

  it("shows connected account details, offline state, and the way out", () => {
    const markup = render({
      status: "linked",
      account: { email: "leo@example.test" },
      environmentId: CloudEnvironmentId.make("cloud-env"),
      connection: "offline",
    });

    expect(markup).toContain("leo@example.test");
    expect(markup).toContain("Offline");
    expect(markup).toContain("Disconnect");
  });

  it("offers relinking after revocation and displays status query failures", () => {
    expect(render({ status: "revoked" })).toContain("Connect again");
    render(null);
    state.error = "The environment request failed.";
    expect(renderToStaticMarkup(<AkeruCloudSettingsPanel />)).toContain(state.error);
  });
});
