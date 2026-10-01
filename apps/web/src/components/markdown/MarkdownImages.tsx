import type { ScopedThreadRef } from "@akeru/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { memo, useState } from "react";
import { useAssetUrlState } from "../../assets/assetUrls";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";

export const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME =
  "h-auto w-auto max-h-[30rem] max-w-[min(100%,30rem)] object-contain";

// block! outranks the unlayered `.chat-markdown img { display: inline-block }`
// rule, keeping workspace images on the same block layout as their placeholder.
const CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME = cn(
  CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
  "my-1 block! rounded-lg border border-border/40",
);

export function ChatMarkdownImageFallback(props: { readonly alt: string }) {
  const { t } = useI18n();
  return (
    <span className="my-1 inline-flex items-center gap-1.5 rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {props.alt.length > 0
        ? t("Image unavailable · {alt}", { alt: props.alt })
        : t("Image unavailable")}
    </span>
  );
}

/** Markdown images whose src is a workspace file path load through a signed asset URL. */
export const ChatMarkdownWorkspaceImage = memo(function ChatMarkdownWorkspaceImage(props: {
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
  readonly alt: string;
}) {
  const { t } = useI18n();
  const assetUrl = useAssetUrlState(props.threadRef.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.path,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (assetUrl._tag === "Failure" || (assetUrl._tag === "Success" && failedUrl === assetUrl.url)) {
    return <ChatMarkdownImageFallback alt={props.alt} />;
  }
  if (assetUrl._tag !== "Success") {
    return (
      <span
        role="status"
        aria-label={t("Loading image")}
        className="my-1 block aspect-video w-full max-w-[30rem] rounded-lg bg-muted/60"
      />
    );
  }
  const knownSize = assetUrl.imageDimensions;
  const sizeStyle = knownSize
    ? {
        width: knownSize.width,
        height: "auto" as const,
        aspectRatio: `${knownSize.width} / ${knownSize.height}`,
        maxWidth: `min(100%, 30rem, ${(30 * knownSize.width) / knownSize.height}rem)`,
      }
    : undefined;
  return (
    <img
      src={assetUrl.url}
      alt={props.alt}
      loading="lazy"
      draggable={false}
      className={CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME}
      style={sizeStyle}
      onError={() => setFailedUrl(assetUrl.url)}
    />
  );
});
