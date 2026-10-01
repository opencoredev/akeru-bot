import { CallEndIcon, CallIcon } from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";

import type { Bot } from "../roster/types";
import { useBotEngineAvailability } from "../roster/useBotEngineAvailability";
import { useRosterStore } from "../roster/rosterStore";
import { Button } from "../ui/button";
import { AppIcon } from "../ui/app-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePrimarySettings } from "../../hooks/useSettings";
import { type ActiveVoiceCall, useVoiceCall } from "./voiceCallContext";

export function BotVoiceCallButtonView({
  bot,
  active,
  disabled,
  disabledReason = null,
  globallyEnabled,
  onClick,
}: {
  readonly bot: Bot;
  readonly active: boolean;
  readonly disabled: boolean;
  /** Why a call cannot start, shown with the button. */
  readonly disabledReason?: string | null;
  readonly globallyEnabled: boolean;
  readonly onClick: () => void;
}) {
  if (!globallyEnabled || !bot.voiceEnabled) return null;
  const label = active ? `Return to call with ${bot.name}` : `Call ${bot.name}`;
  const description = disabled && disabledReason ? `${label}. ${disabledReason}` : label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={description}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        <AppIcon icon={CallIcon} />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{description}</TooltipPopup>
    </Tooltip>
  );
}

export function BotVoiceCallButton({
  bot,
  disabled = false,
}: {
  readonly bot: Bot;
  readonly disabled?: boolean;
}) {
  const { activeCall, startingBotId, startOrReturn } = useVoiceCall();
  const globallyEnabled = usePrimarySettings((settings) => settings.voice.enabled);
  const engine = useBotEngineAvailability(bot.engine);
  const active = activeCall?.botId === bot.id;
  const blocked = engine.blocked && !active;
  return (
    <BotVoiceCallButtonView
      bot={bot}
      active={active}
      disabled={disabled || blocked || startingBotId !== null}
      disabledReason={blocked ? (engine.unavailability?.title ?? null) : null}
      globallyEnabled={globallyEnabled}
      onClick={() => startOrReturn(bot)}
    />
  );
}

export function SelectedBotVoiceCallButton() {
  const bot = useRosterStore((state) =>
    state.selectedBotId === null
      ? null
      : (state.bots.find((candidate) => candidate.id === state.selectedBotId) ?? null),
  );
  return bot ? <BotVoiceCallButton bot={bot} /> : null;
}

export function VoiceCallBar() {
  const { activeCall, hangup, reconnecting, returnToCall, startingBotId } = useVoiceCall();
  const startingBotName = useRosterStore((state) =>
    startingBotId === null
      ? null
      : (state.bots.find((candidate) => candidate.id === startingBotId)?.name ?? "Bot"),
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!activeCall) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeCall]);

  if (!activeCall) {
    return startingBotName ? (
      <VoiceCallStartingBarView botName={startingBotName} onCancel={hangup} />
    ) : null;
  }
  return (
    <VoiceCallBarView
      activeCall={activeCall}
      reconnecting={reconnecting}
      now={now}
      onReturn={returnToCall}
      onHangup={hangup}
    />
  );
}

export function VoiceCallStartingBarView({
  botName,
  onCancel,
}: {
  readonly botName: string;
  readonly onCancel: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-60 flex justify-center px-4">
      <div className="pointer-events-auto flex h-10 items-center rounded-full border border-border bg-background/95 pl-4 pr-1.5 shadow-lg backdrop-blur">
        <span className="pr-3 text-sm font-medium">Calling {botName}</span>
        <Button
          type="button"
          size="icon-sm"
          variant="destructive"
          aria-label={`Cancel call to ${botName}`}
          onClick={onCancel}
        >
          <AppIcon icon={CallEndIcon} />
        </Button>
      </div>
    </div>
  );
}

export function VoiceCallBarView({
  activeCall,
  reconnecting,
  now,
  onReturn,
  onHangup,
}: {
  readonly activeCall: ActiveVoiceCall;
  readonly reconnecting: boolean;
  readonly now: number;
  readonly onReturn: () => void;
  readonly onHangup: () => void;
}) {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(activeCall.startedAt)) / 1_000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");

  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-60 flex justify-center px-4">
      <div className="pointer-events-auto flex h-10 items-center rounded-full border border-border bg-background/95 pl-4 pr-1.5 shadow-lg backdrop-blur">
        <button
          type="button"
          aria-label={`Return to call with ${activeCall.botName}`}
          className="flex items-center gap-2 pr-3"
          onClick={onReturn}
        >
          <span
            className={
              reconnecting ? "size-2 rounded-full bg-warning" : "size-2 rounded-full bg-success"
            }
          />
          <span className="text-sm font-medium">{activeCall.botName}</span>
          {reconnecting ? (
            <span className="text-xs text-muted-foreground">Reconnecting</span>
          ) : null}
          <span className="text-xs tabular-nums text-muted-foreground">
            {minutes}:{seconds}
          </span>
        </button>
        <Button
          type="button"
          size="icon-sm-round"
          variant="destructive"
          aria-label="Hang up"
          onClick={onHangup}
        >
          <AppIcon icon={CallEndIcon} />
        </Button>
      </div>
    </div>
  );
}
