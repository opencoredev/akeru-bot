import { cn } from "../../lib/utils";
import { BotAvatarView } from "./BotAvatarView";
import {
  BOT_PERSONALITY_TONE_OPTIONS,
  BOT_PERSONALITY_TONE_SAMPLE_PROMPT,
  resolveBotPersonalityToneBand,
  resolveBotPersonalityToneOption,
} from "./botPersonalityTone";
import type { Bot } from "./types";

/**
 * Three personality baselines and a written sample. The sample is local copy,
 * so changing the choice never calls a provider.
 */
export function BotPersonalityToneField({
  bot,
  tone,
  onToneChange,
  className,
}: {
  readonly bot: Pick<Bot, "name" | "avatar">;
  readonly tone: number;
  readonly onToneChange: (tone: number) => void;
  readonly className?: string;
}) {
  const selected = resolveBotPersonalityToneOption(tone);
  const band = resolveBotPersonalityToneBand(selected.value);

  return (
    <div className={cn("space-y-4", className)}>
      <div className="space-y-3">
        <div
          role="radiogroup"
          aria-label={`Personality for ${bot.name}`}
          className="grid grid-cols-3 gap-2"
        >
          {BOT_PERSONALITY_TONE_OPTIONS.map((option) => {
            const active = option.value === selected.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onToneChange(option.value)}
                className={cn(
                  "min-h-10 rounded-lg border px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="text-[13px] leading-[1.45] text-muted-foreground/80">{band.summary}</p>
      </div>

      <BotPersonalityTonePreview bot={bot} tone={selected.value} />
    </div>
  );
}

/**
 * A worked example of the current band. Written copy, not a generated reply,
 * so it costs nothing and stays stable while the choice changes.
 */
export function BotPersonalityTonePreview({
  bot,
  tone,
}: {
  readonly bot: Pick<Bot, "name" | "avatar">;
  readonly tone: number;
}) {
  const band = resolveBotPersonalityToneBand(tone);

  return (
    <figure
      className="space-y-3 rounded-xl bg-muted/30 p-4"
      data-testid="bot-personality-tone-preview"
    >
      <figcaption className="text-xs font-medium text-muted-foreground">
        How {bot.name} might sound
      </figcaption>

      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary/10 px-3 py-2 text-[13px] leading-[1.45] text-foreground">
          {BOT_PERSONALITY_TONE_SAMPLE_PROMPT}
        </p>
      </div>

      <div className="flex items-end gap-2">
        <BotAvatarView avatar={bot.avatar} name={bot.name} className="size-6 shrink-0" />
        <p
          key={band.id}
          className="max-w-[85%] rounded-2xl rounded-bl-sm bg-background px-3 py-2 text-[13px] leading-[1.45] text-foreground shadow-sm/5"
        >
          {band.sample}
        </p>
      </div>

      <p className="text-[11px] leading-[1.4] text-muted-foreground/70">
        An illustration of the band, not a live reply.
      </p>
    </figure>
  );
}
