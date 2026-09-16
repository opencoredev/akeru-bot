import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AvatarPickerDialog } from "./AvatarPickerDialog";
import { BotAvatarView } from "./BotAvatarView";
import { useSelectedBot } from "./rosterStore";

/**
 * The active bot's avatar and name, leading the chat header. The avatar opens
 * the avatar picker; the name opens that bot's settings, which is the
 * contextual way into everything else the bot owns.
 */
export function ActiveBotHeaderChip() {
  const bot = useSelectedBot();
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  if (bot === null) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        aria-label={`Change avatar for ${bot.name}`}
        data-bot-hover
        onClick={() => setPickerOpen(true)}
        className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BotAvatarView avatar={bot.avatar} name={bot.name} className="size-6" />
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Settings for ${bot.name}`}
              data-bot-hover
              onClick={() => {
                void navigate({ to: "/bots/$botId/settings", params: { botId: bot.id } });
              }}
              className="max-w-32 cursor-pointer truncate rounded-sm text-sm font-medium text-foreground outline-none transition-colors hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring"
            >
              {bot.name}
            </button>
          }
        />
        <TooltipPopup side="bottom">Bot settings</TooltipPopup>
      </Tooltip>
      {pickerOpen ? <AvatarPickerDialog bot={bot} open onOpenChange={setPickerOpen} /> : null}
    </div>
  );
}
