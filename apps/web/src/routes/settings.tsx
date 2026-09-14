import { createFileRoute, redirect } from "@tanstack/react-router";

import { SettingsRoutePage } from "../components/settings/SettingsRoutePage";

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    if (location.pathname === "/settings") {
      throw redirect({
        to: "/settings/$section",
        params: { section: "general" },
        replace: true,
      });
    }
  },
  component: SettingsRoutePage,
});
