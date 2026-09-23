import { BotId } from "@t3tools/contracts";
import { BotIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { botEnvironment } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import { DEFAULT_BOT_RUNTIME_MODE } from "./botSandbox";
import { NewBotDialog } from "./NewBotDialog";
import type { BotAvatar } from "./types";

/**
 * What a brand-new workspace sees. The old copy named the missing thing and
 * stopped there, leaving the only way forward in a menu on the other side of
 * the window. This says what a bot is for and creates one from here, using the
 * same command the roster's own New bot entry runs.
 */
export function BotZeroState() {
  const environmentId = usePrimaryEnvironmentId();
  const createBot = useAtomCommand(botEnvironment.create, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const handleCreate = async ({ name, avatar }: { name: string; avatar: BotAvatar }) => {
    // A second submit before the first resolves would create a second bot.
    if (creating) return;
    if (environmentId === null) {
      toastManager.add({ type: "error", title: "Connect an environment first" });
      return;
    }
    setCreating(true);
    const result = await createBot({
      environmentId,
      input: {
        botId: BotId.make(`bot-${randomUUID()}`),
        name: name.trim(),
        title: "Assistant",
        label: null,
        description: null,
        avatar,
        engine: null,
        sandbox: null,
        runtimeMode: DEFAULT_BOT_RUNTIME_MODE,
        usageCap: null,
        groupId: null,
      },
    });
    setCreating(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not create bot" });
      return;
    }
    // The roster route watches for the new bot and opens its chat.
    setOpen(false);
  };

  return (
    <>
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border bg-muted/40 text-muted-foreground">
            <BotIcon className="size-5" />
          </div>
          <EmptyTitle>Create your first bot</EmptyTitle>
          <EmptyDescription className="mt-2 leading-relaxed">
            A bot is a teammate you chat with. It keeps its own instructions, memory, tools, and
            schedule, so you can give it a job once and come back to it.
          </EmptyDescription>
          <div className="mt-6 flex flex-col items-center gap-2">
            <Button
              disabled={environmentId === null || creating}
              size="sm"
              onClick={() => setOpen(true)}
            >
              <PlusIcon className="size-4" />
              Create bot
            </Button>
            {environmentId === null ? (
              <span className="text-xs text-muted-foreground">
                Connect an environment to create one.
              </span>
            ) : null}
          </div>
        </EmptyHeader>
      </Empty>
      {open ? (
        <NewBotDialog
          open
          submitting={creating}
          onOpenChange={(next) => {
            if (creating) return;
            setOpen(next);
          }}
          onCreate={(input) => void handleCreate(input)}
        />
      ) : null}
    </>
  );
}
