import { createFileRoute, redirect } from "@tanstack/react-router";

import { SettingsRoutePage } from "../components/settings/SettingsRoutePage";
import { DEFAULT_SETTINGS_SECTION } from "../settingsDialogStore";

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
    if (location.pathname === "/settings") {
      throw redirect({
        to: "/settings/$section",
        params: { section: DEFAULT_SETTINGS_SECTION },
        replace: true,
      });
    }
  },
  component: SettingsRoutePage,
});
