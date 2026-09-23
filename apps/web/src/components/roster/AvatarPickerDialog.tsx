import { useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AvatarColorPicker } from "./AvatarColorPicker";
import { BotAvatarView } from "./BotAvatarView";
import { BLOB_SHAPES, resolveBlobRendering } from "./roster.logic";
import type { Bot, BotAvatar, BotBlobShape } from "./types";
import { useSaveBotAvatar } from "./useServerRoster";

type PickerTab = "bot" | "upload";

// Uploads become small square data URLs so an oversized photo can neither
// bloat the persisted roster nor blow the localStorage quota.
const AVATAR_UPLOAD_SIZE = 128;
const AVATAR_UPLOAD_MAX_FILE_BYTES = 8 * 1024 * 1024;

async function downscaleAvatarImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_UPLOAD_SIZE;
    canvas.height = AVATAR_UPLOAD_SIZE;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D is unavailable.");
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_UPLOAD_SIZE,
      AVATAR_UPLOAD_SIZE,
    );
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}

const TAB_LABELS: Record<PickerTab, string> = {
  bot: "Bot",
  upload: "Upload",
};

/**
 * Avatar picker for one bot. The Bot tab picks a body shape and color;
 * Upload previews a local image and applies it as a data URL until server
 * assets exist.
 */
export function AvatarPickerDialog({
  bot,
  open,
  onOpenChange,
}: {
  bot: Bot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const saveBotAvatar = useSaveBotAvatar();
  const initialBlob = resolveBlobRendering(bot.avatar);
  const [tab, setTab] = useState<PickerTab>("bot");
  const [shape, setShape] = useState<BotBlobShape>(initialBlob.shape);
  const [color, setColor] = useState(initialBlob.color);
  const [upload, setUpload] = useState<string | null>(null);
  const uploadSequence = useRef(0);
  const [failure, setFailure] = useState<"save" | "upload" | "too-large" | null>(null);
  const [saving, setSaving] = useState(false);

  const draftAvatar: BotAvatar | null =
    tab === "bot"
      ? { kind: "blob", shape, color }
      : upload === null
        ? null
        : { kind: "image", assetPath: upload, dithered: false };

  const handleUpload = (file: File | undefined) => {
    if (!file) return;
    const sequence = ++uploadSequence.current;
    // A new selection invalidates both the prior preview and its in-flight
    // decode. Save stays disabled until the latest selection finishes.
    setUpload(null);
    setFailure(null);
    if (file.size > AVATAR_UPLOAD_MAX_FILE_BYTES) {
      setFailure("too-large");
      return;
    }
    void downscaleAvatarImage(file).then(
      (rendering) => {
        if (sequence === uploadSequence.current) setUpload(rendering);
      },
      (error: unknown) => {
        if (sequence !== uploadSequence.current) return;
        console.error("Could not read avatar image.", error);
        setFailure("upload");
      },
    );
  };

  const handleSave = async () => {
    if (draftAvatar === null || saving) return;
    setSaving(true);
    const saved = await saveBotAvatar(bot.id, draftAvatar);
    setSaving(false);
    if (!saved) {
      setFailure("save");
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Avatar</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <ToggleGroup
            aria-label="Avatar source"
            variant="segmented"
            className="w-full *:flex-1"
            value={[tab]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "bot" || value === "upload") {
                setFailure(null);
                setTab(value);
              }
            }}
          >
            {(["bot", "upload"] as const).map((option) => (
              <Toggle key={option} value={option}>
                {TAB_LABELS[option]}
              </Toggle>
            ))}
          </ToggleGroup>
          {tab === "bot" ? (
            <>
              <div className="flex justify-center">
                <BotAvatarView
                  avatar={{ kind: "blob", shape, color }}
                  name={bot.name}
                  className="size-20"
                />
              </div>
              <div className="grid grid-cols-4 gap-2">
                {BLOB_SHAPES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-label={option}
                    aria-pressed={shape === option}
                    data-bot-hover
                    onClick={() => setShape(option)}
                    className={cn(
                      "flex cursor-pointer items-center justify-center rounded-md p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      shape === option ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <BotAvatarView
                      avatar={{ kind: "blob", shape: option, color }}
                      name=""
                      className="size-9"
                    />
                  </button>
                ))}
              </div>
              <AvatarColorPicker className="mx-auto" value={color} onChange={setColor} />
            </>
          ) : (
            <div className="flex h-40 flex-col items-center justify-center gap-3">
              {upload !== null ? (
                <img
                  src={upload}
                  alt="Avatar preview"
                  className="size-20 rounded-full object-cover"
                />
              ) : null}
              <label className="cursor-pointer text-sm font-medium text-foreground underline-offset-4 hover:underline">
                Choose image
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={(event) => handleUpload(event.currentTarget.files?.[0])}
                />
              </label>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {failure !== null ? (
            <p role="alert" className="mr-auto self-center text-sm text-destructive">
              {failure === "save"
                ? "Could not save"
                : failure === "too-large"
                  ? "Image too large"
                  : "Could not read image"}
            </p>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={draftAvatar === null || saving}>
            {saving ? "Saving" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
