import type { OrchestrationMessageReaction } from "@t3tools/contracts";

import { useI18n } from "~/i18n";
import { cn } from "~/lib/utils";
import { reactionOptionFromEmoji } from "./MessageControls";

/**
 * Applied reactions under a message. When the caller passes `onToggle`, the chip the
 * current person owns becomes a button that removes it again, so a reaction is never a
 * one-way door for anyone who cannot reach the hover picker.
 *
 * A stored emoji this client cannot send back — one from another client, or from an older
 * option set — stays plain text. Offering a button that cannot act would be a dead control.
 */
export function MessageReactions({
  reactions,
  selectedEmoji = null,
  align = "start",
  onToggle,
}: {
  readonly reactions: ReadonlyArray<OrchestrationMessageReaction>;
  readonly selectedEmoji?: string | null;
  readonly align?: "start" | "end";
  readonly onToggle?: (emoji: string) => void;
}) {
  const { t } = useI18n();
  const counts = new Map<string, number>();
  for (const reaction of reactions) {
    counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  return (
    <div
      className={cn("mt-1.5 flex flex-wrap gap-1.5", align === "end" && "justify-end")}
      data-testid="message-reactions"
    >
      {[...counts].map(([emoji, count]) => {
        const mine = selectedEmoji === emoji;
        const label = (
          <>
            {emoji}
            {count > 1 ? (
              <span className="font-sans text-xs font-medium text-muted-foreground">{count}</span>
            ) : null}
          </>
        );
        const className = cn(
          "inline-flex min-h-8 items-center gap-1 rounded-full border px-2.5 py-1 text-lg leading-none [font-family:'Apple_Color_Emoji','Segoe_UI_Emoji',sans-serif]",
          mine ? "border-primary/40 bg-primary/10" : "border-border/80 bg-background/70",
        );
        if (!onToggle || reactionOptionFromEmoji(emoji) === null) {
          return (
            <span className={className} data-reaction-emoji={emoji} key={emoji}>
              {label}
            </span>
          );
        }
        return (
          <button
            aria-label={
              mine ? t("Remove your {emoji} reaction", { emoji }) : t("React {emoji}", { emoji })
            }
            aria-pressed={mine}
            className={cn(
              className,
              "cursor-pointer transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            data-reaction-emoji={emoji}
            key={emoji}
            onClick={() => onToggle(emoji)}
            type="button"
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
