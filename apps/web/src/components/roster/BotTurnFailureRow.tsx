import { CircleAlertIcon } from "lucide-react";

import { useI18n } from "../../i18n";

/**
 * Fills the reply slot under a request that failed, so the chat never shows a
 * sent message with nothing after it. The error banner below carries the fix.
 */
export function BotTurnFailureRow({
  botName,
  title,
}: {
  readonly botName: string;
  readonly title: string;
}) {
  const { t } = useI18n();
  return (
    <p
      className="mx-auto flex w-full max-w-3xl items-start gap-2 px-2 py-2 text-xs text-muted-foreground"
      data-testid="bot-turn-failure"
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 whitespace-normal break-words leading-5">
        {t("{botName} did not reply. {title}.", { botName, title })}
      </span>
    </p>
  );
}
