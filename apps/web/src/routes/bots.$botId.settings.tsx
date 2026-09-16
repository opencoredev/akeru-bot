import { createFileRoute, redirect } from "@tanstack/react-router";

import { BotSettingsPage } from "../components/roster/BotSettingsPage";

export const Route = createFileRoute("/bots/$botId/settings")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: () => <BotSettingsPage botId={Route.useParams().botId} />,
});
