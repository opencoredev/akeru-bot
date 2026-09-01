import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
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
  const images = props.attachments.map((attachment, index) => ({
    ...attachment,
    ...(urls[index] ? { previewUrl: urls[index] } : {}),
  }));

  if (images.length === 0) return null;

  return (
    <>
      <div
        className={cn("grid max-w-[520px] grid-cols-1 gap-2 sm:grid-cols-2", props.className)}
        data-testid="message-image-attachments"
      >
        {images.map((image) => (
          <div
            key={image.id}
            className="overflow-hidden rounded-xl border border-border/80 bg-background/70"
          >
            {image.previewUrl ? (
              <button
                type="button"
                className="block w-full cursor-zoom-in"
                aria-label={`Preview ${image.name}`}
                onClick={() => {
                  const preview = buildExpandedImagePreview(images, image.id);
                  if (preview) setExpanded(preview);
                }}
              >
                <img
                  src={image.previewUrl}
                  alt={image.name}
                  className="block max-h-[320px] w-full object-cover"
                />
              </button>
            ) : (
              <div className="flex min-h-24 items-center justify-center px-3 py-4 text-center text-muted-foreground text-xs">
                {image.name}
              </div>
            )}
          </div>
        ))}
      </div>
      {expanded ? (
        <ExpandedImageDialog preview={expanded} onClose={() => setExpanded(null)} />
      ) : null}
    </>
  );
}
