import { useState } from "react";

import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readFileAsDataUrl } from "../ChatView.logic";
import { ProviderUnavailableNotice } from "../chat/ProviderUnavailableNotice";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { AvatarColorPicker } from "./AvatarColorPicker";
import { BotAvatarView } from "./BotAvatarView";
import { BLOB_SHAPES, blobShapeLabel, randomBotAvatar } from "./roster.logic";
import type { BotAvatar } from "./types";
import { useBotEngineAvailability } from "./useBotEngineAvailability";

/** A compact bot creation form with all required choices in one view. */
export function NewBotDialog({
  open,
  onOpenChange,
  onCreate,
  /** Set while a create is in flight, so the form cannot be submitted twice. */
  submitting = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; avatar: BotAvatar }) => void;
  submitting?: boolean;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [blobAvatar, setBlobAvatar] = useState(() => randomBotAvatar());
  const [avatar, setAvatar] = useState<BotAvatar>(() => blobAvatar);
  const trimmedName = name.trim();
  const environmentId = usePrimaryEnvironmentId();
  // A new bot answers with the app default. When no provider can run it, say so
  // here; the bot is still created and can reply once a provider connects.
  const defaultEngine = useBotEngineAvailability(null);

  const updateBlobAvatar = (next: typeof blobAvatar) => {
    setBlobAvatar(next);
    setAvatar(next);
  };

  const handleUpload = (file: File | undefined) => {
    if (!file) return;
    void readFileAsDataUrl(file).then(
      (assetPath) => {
        setAvatar({ kind: "image", assetPath, dithered: false });
      },
      (error: unknown) => {
        console.error("Could not read avatar image.", error);
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg overflow-hidden p-0" bottomStickOnMobile={false}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (submitting || trimmedName.length === 0) return;
            onCreate({ name: trimmedName, avatar });
          }}
        >
          <header className="border-b px-6 py-5">
            <DialogTitle>{t("New bot")}</DialogTitle>
          </header>

          <div className="space-y-6 px-6 py-6">
            {defaultEngine.blocked && defaultEngine.unavailability ? (
              <ProviderUnavailableNotice
                presentation={defaultEngine.unavailability}
                environmentId={environmentId}
              />
            ) : null}
            <div className="flex items-center gap-4">
              <BotAvatarView avatar={avatar} name={trimmedName} className="size-16 shrink-0" />
              <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm font-medium text-foreground">
                <span>
                  {t("Name")}{" "}
                  <span className="text-destructive" aria-hidden="true">
                    *
                  </span>
                  <span className="sr-only"> {t("(required)")}</span>
                </span>
                <Input
                  autoFocus
                  aria-describedby="new-bot-name-help"
                  data-testid="new-bot-name-input"
                  maxLength={80}
                  placeholder={t("Bot name")}
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <span
                  id="new-bot-name-help"
                  className={cn(
                    "text-xs font-normal",
                    trimmedName.length === 0 ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {trimmedName.length === 0
                    ? t("Enter a name to create this bot.")
                    : t("This is how the bot appears in your roster.")}
                </span>
              </label>
            </div>

            <section aria-labelledby="new-bot-avatar-heading" className="space-y-4 border-t pt-5">
              <div className="flex items-center justify-between gap-3">
                <h3 id="new-bot-avatar-heading" className="text-sm font-medium text-foreground">
                  {t("Avatar")}
                </h3>
                <label className="cursor-pointer rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow-xs/5 outline-none transition-colors hover:bg-accent focus-within:ring-2 focus-within:ring-ring">
                  {t("Upload image")}
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => handleUpload(event.currentTarget.files?.[0])}
                  />
                </label>
              </div>

              <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                {BLOB_SHAPES.map((shape) => {
                  const selected = avatar.kind === "blob" && blobAvatar.shape === shape;
                  return (
                    <button
                      key={shape}
                      type="button"
                      aria-label={blobShapeLabel(shape, t)}
                      aria-pressed={selected}
                      data-bot-hover
                      onClick={() => updateBlobAvatar({ ...blobAvatar, shape })}
                      className={cn(
                        "flex aspect-square cursor-pointer items-center justify-center rounded-lg border border-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                        selected ? "border-border bg-accent" : "hover:bg-accent/60",
                      )}
                    >
                      <BotAvatarView
                        avatar={{ ...blobAvatar, shape }}
                        name={trimmedName}
                        className="size-9"
                      />
                    </button>
                  );
                })}
              </div>

              <AvatarColorPicker
                value={blobAvatar.color}
                onChange={(color) => updateBlobAvatar({ ...blobAvatar, color })}
              />
            </section>
          </div>

          <footer className="flex justify-end gap-2 border-t bg-muted px-6 py-4">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              aria-describedby={trimmedName.length === 0 ? "new-bot-name-help" : undefined}
              className="disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
              disabled={submitting || trimmedName.length === 0}
            >
              {submitting ? t("Creating") : t("Create bot")}
            </Button>
          </footer>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
