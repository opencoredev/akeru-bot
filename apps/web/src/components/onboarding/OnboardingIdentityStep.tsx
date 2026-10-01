import { ArrowLeftIcon, ArrowRightIcon, LoaderIcon } from "lucide-react";

import { useI18n } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AvatarColorPicker } from "../roster/AvatarColorPicker";
import { BotAvatarView } from "../roster/BotAvatarView";
import { BLOB_SHAPES } from "../roster/roster.logic";
import type { DesktopOnboardingDraft } from "./desktopOnboardingDraft";
import type { DesktopOnboardingCreationReadiness } from "./desktopOnboardingEngine";
import { ONBOARDING_HEADING_CLASS } from "./onboardingStyles";

export function IdentityStep({
  draft,
  creating,
  providerReadiness,
  error,
  onChange,
  onBack,
  onContinue,
}: {
  readonly draft: DesktopOnboardingDraft;
  readonly creating: boolean;
  readonly providerReadiness: DesktopOnboardingCreationReadiness;
  readonly error: string | null;
  readonly onChange: (draft: DesktopOnboardingDraft) => void;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className={ONBOARDING_HEADING_CLASS}>{t("Give it a name")}</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          {t("You will call on this bot by name every day. Pick one that sounds like a teammate.")}
        </p>
      </div>
      <label className="flex w-full flex-col gap-2 text-sm font-medium">
        {t("Name")}
        <Input
          autoFocus
          size="lg"
          value={draft.name}
          maxLength={80}
          placeholder={t("Nova, Scout, Dispatch…")}
          onChange={(event) => onChange({ ...draft, name: event.currentTarget.value })}
        />
      </label>
      <section aria-label={t("Avatar")} className="space-y-5 border-t pt-5">
        <div className="space-y-3">
          <h2 className="text-xs font-medium text-muted-foreground">{t("Shape")}</h2>
          <div className="grid grid-cols-8 gap-1.5">
            {BLOB_SHAPES.map((shape) => (
              <button
                key={shape}
                type="button"
                aria-label={t("{shape} avatar", { shape })}
                aria-pressed={draft.avatar.shape === shape}
                onClick={() => onChange({ ...draft, avatar: { ...draft.avatar, shape } })}
                className={`flex aspect-square items-center justify-center rounded-lg border border-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                  draft.avatar.shape === shape ? "border-border bg-accent" : "hover:bg-accent/60"
                }`}
              >
                <BotAvatarView
                  avatar={{ ...draft.avatar, shape }}
                  name={draft.name || t("Bot")}
                  className="size-7"
                />
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <h2 className="text-xs font-medium text-muted-foreground">{t("Color")}</h2>
          <AvatarColorPicker
            value={draft.avatar.color}
            onChange={(color) => onChange({ ...draft, avatar: { ...draft.avatar, color } })}
          />
        </div>
      </section>
      {providerReadiness.status === "loading" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
          {t("Preparing your provider…")}
        </p>
      ) : providerReadiness.status === "unavailable" ? (
        <p className="text-sm text-destructive">
          {t("This provider is not ready. Go back and reconnect it.")}
        </p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}
      <div className="flex gap-2">
        <Button size="icon" variant="ghost-muted" aria-label={t("Back")} onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
        </Button>
        <Button
          size="onboarding"
          className="flex-1"
          disabled={!draft.name.trim() || creating || providerReadiness.status !== "ready"}
          onClick={onContinue}
        >
          {creating ? (
            <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
          ) : null}
          {t("Continue")}
          {!creating ? <ArrowRightIcon className="size-4" /> : null}
        </Button>
      </div>
    </div>
  );
}
