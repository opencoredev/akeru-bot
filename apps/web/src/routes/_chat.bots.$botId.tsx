import { BotId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BotThreadLanding } from "../components/roster/BotThreadLanding";
import { BotDetailsPanel } from "../components/roster/BotDetailsPanel";
import { useBotThreadRef } from "../components/roster/useBotThreadRef";
import { useRosterStore } from "../components/roster/rosterStore";
import { toastManager } from "../components/ui/toast";
import { botEnvironment } from "../state/bots";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";

function BotThreadRouteView() {
  const { botId } = Route.useParams();
  const environmentId = usePrimaryEnvironmentId();
  const updateBot = useAtomCommand(botEnvironment.update, { reportFailure: false });
  const bot = useRosterStore((state) =>
    state.bots.find((candidate) => candidate.id === botId && candidate.archivedAt === null),
  );
  const threadRef = useBotThreadRef(botId);

  return (
    <>
      <BotThreadLanding botId={botId} />
      {bot ? (
        <BotDetailsPanel
          key={bot.id}
          bot={bot}
          threadRef={threadRef}
          onSaveBot={async ({
            name,
            label,
            description,
            engine,
            sandbox,
            voiceEnabled,
            disabledMcpServerIds,
          }) => {
            if (!environmentId) return false;
            const result = await updateBot({
              environmentId,
              input: {
                botId: BotId.make(bot.id),
                name,
                label,
                description,
                engine,
                sandbox,
                voiceEnabled,
                disabledMcpServerIds,
              },
            });
            if (result._tag === "Failure") {
              toastManager.add({ type: "error", title: "Could not save bot settings" });
              return false;
            }
            toastManager.add({ type: "success", title: "Bot settings saved" });
            return true;
          }}
        />
      ) : null}
    </>
  );
}

export const Route = createFileRoute("/_chat/bots/$botId")({
  component: BotThreadRouteView,
});
