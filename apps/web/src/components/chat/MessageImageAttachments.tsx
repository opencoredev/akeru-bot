import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { FileTextIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";

import { ExpandedImageDialog } from "./ExpandedImageDialog";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

export function MessageImageAttachments(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly className?: string;
}) {
  const resources = useMemo(
    () =>
      props.attachments.map((attachment) => ({
        _tag: "attachment" as const,
        attachmentId: attachment.id,
      })),
    [props.attachments],
  );
  const urls = useAssetUrls(props.environmentId, resources);
  const [expanded, setExpanded] = useState<ExpandedImagePreview | null>(null);
  const attachments = props.attachments.map((attachment, index) => ({
    ...attachment,
    ...(urls[index] ? { previewUrl: urls[index] } : {}),
  }));
  const images = attachments.filter((attachment) => attachment.type === "image");

  if (attachments.length === 0) return null;

  return (
    <>
      <div
        className={cn("grid max-w-[520px] grid-cols-1 gap-2 sm:grid-cols-2", props.className)}
        data-testid="message-image-attachments"
      >
        {attachments.map((attachment) =>
          attachment.type === "file" ? (
            <a
              key={attachment.id}
              className="flex min-h-14 items-center gap-2 rounded-xl border border-border/80 bg-background/70 px-3 py-2 text-sm hover:bg-muted/50"
              href={attachment.previewUrl}
              download={attachment.name}
            >
              <FileTextIcon className="size-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{attachment.name}</span>
            </a>
          ) : (
            <div
              key={attachment.id}
              className="overflow-hidden rounded-xl border border-border/80 bg-background/70"
            >
              {attachment.previewUrl ? (
                <button
                  type="button"
                  className="block w-full cursor-zoom-in"
                  aria-label={`Preview ${attachment.name}`}
                  onClick={() => {
                    const preview = buildExpandedImagePreview(images, attachment.id);
                    if (preview) setExpanded(preview);
                  }}
                >
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="block max-h-[320px] w-full object-cover"
                  />
                </button>
              ) : (
                <div className="flex min-h-24 items-center justify-center px-3 py-4 text-center text-muted-foreground text-xs">
                  {attachment.name}
                </div>
              )}
            </div>
          ),
        )}
      </div>
      {expanded ? (
        <ExpandedImageDialog preview={expanded} onClose={() => setExpanded(null)} />
      ) : null}
    </>
  );
}
