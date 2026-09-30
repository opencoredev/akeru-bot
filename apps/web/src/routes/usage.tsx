import { createFileRoute, redirect } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";

export const Route = createFileRoute("/usage")({
  beforeLoad: async ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: UsagePage,
});
