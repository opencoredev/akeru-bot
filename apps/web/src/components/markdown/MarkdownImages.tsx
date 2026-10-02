import { Data } from "effect";
import { AssetResource } from "@akeru/contracts";
import { Predicate } from "effect";
import type { ScopedThreadRef } from "@akeru/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { memo, useState } from "react";
import { useAssetUrlState } from "../../assets/assetUrls";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";

const AssetResources = Data.taggedEnum<AssetResource>();

export const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME =
  "h-auto w-auto max-h-120 max-w-min-full-30rem object-contain";

// block! outranks the unlayered `.chat-markdown img { display: inline-block }`
// rule, keeping workspace images on the same block layout as their placeholder.
const CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME = cn(
  CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
  "my-1 block! rounded-lg border border-border/40",
);

// Workspace images with known dimensions reserve their box before loading.
const CHAT_MARKDOWN_KNOWN_SIZE_IMAGE_CLASS_NAME = cn(
  "h-auto w-(--image-width) max-h-120 max-w-(--image-max-width) aspect-(--image-aspect) object-contain",
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

  const assetUrl = useAssetUrlState(
    props.threadRef.environmentId,
    AssetResources["workspace-file"]({ threadId: props.threadRef.threadId, path: props.path }),
  );

  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (
    Predicate.isTagged(assetUrl, "Failure") ||
    (Predicate.isTagged(assetUrl, "Success") && failedUrl === assetUrl.url)
  ) {
    return <ChatMarkdownImageFallback alt={props.alt} />;
  }

  if (!Predicate.isTagged(assetUrl, "Success")) {
    return (
      <span
        role="status"
        aria-label={t("Loading image")}
        className="my-1 block aspect-video w-full max-w-120 rounded-lg bg-muted/60"
      />
    );
  }

  const knownSize = assetUrl.imageDimensions;

  const sizeStyle = knownSize
    ? {
        "--image-width": `${knownSize.width}px`,
        "--image-aspect": `${knownSize.width} / ${knownSize.height}`,
        "--image-max-width": `min(100%, 30rem, ${(30 * knownSize.width) / knownSize.height}rem)`,
      }
    : undefined;

  return (
    <img
      src={assetUrl.url}
      alt={props.alt}
      loading="lazy"
      draggable={false}
      className={
        knownSize
          ? CHAT_MARKDOWN_KNOWN_SIZE_IMAGE_CLASS_NAME
          : CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME
      }
      style={sizeStyle}
      onError={() => setFailedUrl(assetUrl.url)}
    />
  );
});
