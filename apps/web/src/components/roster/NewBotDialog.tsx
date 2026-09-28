import { useState } from "react";

import { useI18n } from "../../i18n";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { ProviderUnavailableNotice } from "../chat/ProviderUnavailableNotice";

import { cn } from "../../lib/utils";
import { readFileAsDataUrl } from "../ChatView.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
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
  const environmentId = usePrimaryEnvironmentId();
  // A new bot answers with the app default. When no provider can run it, say so
  // here; the bot is still created and can reply once a provider connects.
  const defaultEngine = useBotEngineAvailability(null);
  const [name, setName] = useState("");
  const [blobAvatar, setBlobAvatar] = useState(() => randomBotAvatar());
  const [avatar, setAvatar] = useState<BotAvatar>(() => blobAvatar);
  const trimmedName = name.trim();

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
      <DialogPopup
        className="flex max-h-[calc(100dvh-2rem)] max-w-2xl flex-col overflow-hidden"
        bottomStickOnMobile={false}
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (submitting || trimmedName.length === 0) return;
            onCreate({ name: trimmedName, avatar });
          }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>New bot</DialogTitle>
            <DialogDescription>
              Give your teammate an identity. You can set its model and instructions next.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="grid gap-6 sm:grid-cols-[12rem_minmax(0,1fr)]">
            {defaultEngine.blocked && defaultEngine.unavailability ? (
              <div className="sm:col-span-2">
                <ProviderUnavailableNotice
                  presentation={defaultEngine.unavailability}
                  environmentId={environmentId}
                />
              </div>
            ) : null}
            <div className="flex flex-col items-center justify-center rounded-2xl border border-border/70 bg-secondary/35 px-4 py-7 text-center">
              <BotAvatarView avatar={avatar} name={trimmedName} className="size-20" />
              <div className="mt-4 max-w-full truncate text-sm font-semibold">
                {trimmedName || "Your bot"}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Preview</p>
            </div>

            <div className="min-w-0 space-y-6">
              <label className="flex flex-col gap-2 text-sm font-medium">
                Bot name
                <Input
                  autoFocus
                  data-testid="new-bot-name-input"
                  maxLength={80}
                  placeholder="Name your bot"
                  required
                  aria-describedby="new-bot-name-help"
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

              <section
                aria-labelledby="new-bot-avatar-heading"
                className="space-y-4 border-t border-border/70 pt-5"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 id="new-bot-avatar-heading" className="text-sm font-medium text-foreground">
                    Appearance
                  </h3>
                  <label className="cursor-pointer rounded-lg border border-border bg-secondary/60 px-3 py-1.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-within:ring-2 focus-within:ring-foreground/20">
                    Upload image
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(event) => handleUpload(event.currentTarget.files?.[0])}
                    />
                  </label>
                </div>

                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
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
                          "flex aspect-square cursor-pointer items-center justify-center rounded-xl border border-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-foreground/20",
                          selected ? "border-border bg-secondary" : "hover:bg-secondary/70",
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
          </DialogPanel>

          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              aria-describedby={trimmedName.length === 0 ? "new-bot-name-help" : undefined}
              className="disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
              disabled={submitting || trimmedName.length === 0}
            >
              {submitting ? t("Creating") : t("Create bot")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
