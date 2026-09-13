import { useState } from "react";

import { cn } from "../../lib/utils";
import { readFileAsDataUrl } from "../ChatView.logic";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { AvatarColorPicker } from "./AvatarColorPicker";
import { BotAvatarView } from "./BotAvatarView";
import { BLOB_SHAPES, randomBotAvatar } from "./roster.logic";
import type { BotAvatar } from "./types";

/** A compact bot creation form with all required choices in one view. */
export function NewBotDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; avatar: BotAvatar }) => void;
}) {
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
      <DialogPopup className="max-w-lg overflow-hidden p-0" bottomStickOnMobile={false}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmedName.length === 0) return;
            onCreate({ name: trimmedName, avatar });
          }}
        >
          <header className="border-b px-6 py-5">
            <DialogTitle>New bot</DialogTitle>
          </header>

          <div className="space-y-6 px-6 py-6">
            <div className="flex items-center gap-4">
              <BotAvatarView avatar={avatar} name={trimmedName} className="size-16 shrink-0" />
              <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm font-medium text-foreground">
                Name
                <Input
                  autoFocus
                  data-testid="new-bot-name-input"
                  maxLength={80}
                  placeholder="Bot name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            </div>

            <section aria-labelledby="new-bot-avatar-heading" className="space-y-4 border-t pt-5">
              <div className="flex items-center justify-between gap-3">
                <h3 id="new-bot-avatar-heading" className="text-sm font-medium text-foreground">
                  Avatar
                </h3>
                <label className="cursor-pointer rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow-xs/5 outline-none transition-colors hover:bg-accent focus-within:ring-2 focus-within:ring-ring">
                  Upload image
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
                      aria-label={shape}
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmedName.length === 0}>
              Create bot
            </Button>
          </footer>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
