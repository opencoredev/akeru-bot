import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { FileTextIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "../chat/ExpandedImagePreview";

export function buildBotMessageAttachmentPreview(
  attachments: ReadonlyArray<ChatAttachment>,
  urls: ReadonlyArray<string | null>,
  selectedAttachmentId: string,
  failedIds: ReadonlySet<string> = new Set(),
): ExpandedImagePreview | null {
  return buildExpandedImagePreview(
    attachments.flatMap((attachment, index) =>
      attachment.type === "image"
        ? [
            {
              id: attachment.id,
              name: attachment.name,
              ...(urls[index] && !failedIds.has(attachment.id) ? { previewUrl: urls[index] } : {}),
            },
          ]
        : [],
    ),
    selectedAttachmentId,
  );
}

export function BotMessageAttachments({
  attachments,
  environmentId,
}: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly environmentId: EnvironmentId;
}) {
  const resources = useMemo(
    () =>
      attachments.map((attachment) => ({
        _tag: "attachment" as const,
        attachmentId: attachment.id,
      })),
    [attachments],
  );
  const urls = useAssetUrls(environmentId, resources);
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  if (attachments.length === 0) return null;

  return (
    <>
      <div className="grid max-w-[420px] grid-cols-1 gap-2 sm:grid-cols-2">
        {attachments.map((attachment, index) => {
          const url = urls[index];
          const canPreview =
            attachment.type === "image" && url !== null && !failedIds.has(attachment.id);
          if (attachment.type === "file") {
            return (
              <a
                key={attachment.id}
                data-testid="bot-message-attachment"
                className="flex min-h-14 items-center gap-2 rounded-lg border border-border/70 bg-background/45 px-3 py-2 text-sm hover:bg-muted/50"
                href={url ?? undefined}
                download={attachment.name}
              >
                <FileTextIcon className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{attachment.name}</span>
              </a>
            );
          }
          return (
            <div
              key={attachment.id}
              data-testid="bot-message-attachment"
              className="aspect-[4/3] min-h-20 overflow-hidden rounded-lg border border-border/70 bg-background/45"
            >
              {canPreview ? (
                <button
                  type="button"
                  aria-label={`Preview ${attachment.name}`}
                  className="size-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  onClick={() =>
                    setPreview(
                      buildBotMessageAttachmentPreview(attachments, urls, attachment.id, failedIds),
                    )
                  }
                >
                  <img
                    src={url}
                    alt={attachment.name}
                    className="size-full max-h-[220px] object-cover"
                    draggable={false}
                    onError={() => setFailedIds((current) => new Set(current).add(attachment.id))}
                  />
                </button>
              ) : (
                <span className="flex size-full items-center justify-center text-xs text-muted-foreground">
                  Image unavailable
                </span>
              )}
            </div>
          );
        })}
      </div>
      {preview ? <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}
