import { createFileRoute, redirect } from "@tanstack/react-router";

import { PluginsPage } from "../components/plugins/PluginsDialog";

export const Route = createFileRoute("/plugins")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: PluginsPage,
});
