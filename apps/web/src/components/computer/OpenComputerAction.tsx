import { ComputerIcon } from "@hugeicons/core-free-icons";
import type { ScopedThreadRef } from "@akeru/contracts";

import { openComputerViewer } from "../../computerViewerStore";
import { useI18n } from "../../i18n";
import type { Bot } from "../roster/types";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";

/** Opens the bot's computer beside a request for human input, when the chat has a thread. */
export function OpenComputerAction({
  threadRef,
  bot,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly bot: Pick<Bot, "name" | "sandbox" | "engine">;
}) {
  const { t } = useI18n();
  if (threadRef === null) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      data-open-computer=""
      onClick={() =>
        openComputerViewer({
          threadRef,
          botName: bot.name,
          sandbox: bot.sandbox,
          engine: bot.engine,
        })
      }
    >
      <AppIcon className="size-3.5" icon={ComputerIcon} />
      {t("Open {name}'s computer", { name: bot.name })}
    </Button>
  );
}
