import { Predicate } from "effect";
import { BotId } from "@akeru/contracts";
import { BotIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { botEnvironment } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { useI18n } from "../../i18n";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import { DEFAULT_BOT_RUNTIME_MODE } from "./botSandbox";
import { NewBotDialog } from "./NewBotDialog";
import type { BotAvatar } from "./types";

/**
 * Empty roster after skip or a cleared workspace. Sells creating a teammate
 * without framing it as a failed setup wizard.
 */
export function BotZeroState() {
  const { t } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  const createBot = useAtomCommand(botEnvironment.create, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const handleCreate = async ({ name, avatar }: { name: string; avatar: BotAvatar }) => {
    // A second submit before the first resolves would create a second bot.
    if (creating) return;

    if (environmentId === null) {
      toastManager.add({ type: "error", title: t("Connect an environment first") });

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
        groupId: null,
      },
    });

    setCreating(false);

    if (Predicate.isTagged(result, "Failure")) {
      toastManager.add({ type: "error", title: t("Could not create bot") });

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
          <EmptyTitle>{t("Create a teammate")}</EmptyTitle>
          <EmptyDescription className="mt-2 leading-relaxed">
            {t(
              "Name a bot when you are ready to chat. Connect a provider in Settings first if you want it to answer right away.",
            )}
          </EmptyDescription>
          <div className="mt-6 flex flex-col items-center gap-2">
            <Button
              disabled={environmentId === null || creating}
              size="sm"
              onClick={() => setOpen(true)}
            >
              <PlusIcon className="size-4" />
              {t("Create bot")}
            </Button>
            {environmentId === null ? (
              <span className="text-xs text-muted-foreground">
                {t("Connect an environment to create one.")}
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
