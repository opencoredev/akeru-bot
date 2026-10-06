import { recordLookup } from "./recordLookup";
import { Predicate } from "effect";
import { classifyMarkdownImageSource } from "@akeru/client-runtime/markdown-images";
import { stabilizeStreamingMarkdown } from "@akeru/client-runtime/markdown-streaming";
import { isAppDeepLink } from "@akeru/client-runtime/settings-deep-link";
import { isAtomCommandInterrupted } from "@akeru/client-runtime/state/runtime";
import "katex/dist/katex.min.css";
import {
  InfoIcon,
  LightbulbIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { memo, Suspense, use } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { useI18n } from "../i18n";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import {
  normalizeMarkdownLinkDestination,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
} from "../markdown-links";
import { MARKDOWN_DIFF_LANGUAGES } from "../markdownDiff";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { parseSettingsDeepLink } from "../settingsDeepLink";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { SettingsLinkChip } from "./chat/SettingsLinkChip";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import {
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from "./chat/externalLinkContextMenu";
import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  MarkdownCodeBlock,
  MarkdownDiffBlock,
  MarkdownMathExpression,
  MarkdownMermaidDiagram,
  SuspenseShikiCodeBlock,
} from "./markdown/MarkdownCodeBlock";
import {
  CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
  ChatMarkdownImageFallback,
  ChatMarkdownWorkspaceImage,
} from "./markdown/MarkdownImages";
import {
  handleMarkdownFragmentClick,
  hastHasText,
  MarkdownExternalLinkContent,
  normalizeMarkdownLinkHrefKey,
  plainHastText,
} from "./markdown/MarkdownLinks";
import {
  findTaskListMarkerOffset,
  MarkdownList,
  orderedListGutter,
} from "./markdown/MarkdownLists";
import { ChatMarkdownRendererContext } from "./markdown/MarkdownRendererContext";
import { GenerativeBlock } from "./markdown/generative/GenerativeBlock";
import { GenerativeBlockPending } from "./markdown/generative/GenerativeFrame";
import {
  decodeGenerativeBlock,
  generativeKindForLanguage,
} from "./markdown/generative/generativeSchemas";
import { MarkdownDetails, MarkdownTable } from "./markdown/MarkdownTable";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS_WITH_RAW_HTML,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./markdown/markdownPlugins";
import { nodeToPlainText } from "./markdown/markdownText";
import {
  reportMarkdownActionFailure,
  useChatMarkdownState,
  type ChatMarkdownProps,
} from "./markdown/useChatMarkdownState";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** GitHub's own five alert kinds, in its colors: the glyph names the urgency, the title says it. */
const GITHUB_ALERT_PRESENTATIONS = {
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-markdown-note/70",
    titleClassName: "text-markdown-note-foreground",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-markdown-tip/70",
    titleClassName: "text-markdown-tip-foreground",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-markdown-important/70",
    titleClassName: "text-markdown-important-foreground",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-markdown-warning/70",
    titleClassName: "text-markdown-warning-foreground",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-markdown-caution/70",
    titleClassName: "text-markdown-caution-foreground",
  },
} satisfies Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
>;

// Keep component types stable when streaming changes the message state.
const CHAT_MARKDOWN_COMPONENTS: Components = {
  p: function MarkdownParagraph({ node: _node, children, ...props }) {
    const { skills } = use(ChatMarkdownRendererContext);

    return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
  },
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const alert = recordLookup(
      GITHUB_ALERT_PRESENTATIONS,
      String(("data-alert" in props ? props["data-alert"] : "") ?? ""),
    );

    if (!alert) {
      return <blockquote {...props}>{children}</blockquote>;
    }

    // Not a <blockquote>: the stylesheet mutes those, and an alert's body is ordinary
    // text under a colored title — which is how the host renders it.
    return (
      <div role="note" className={cn("my-1 border-l-2 pl-3", alert.borderClassName)}>
        <p className={cn("flex items-center gap-1.5 font-medium", alert.titleClassName)}>
          <alert.Icon aria-hidden className="size-3.5 shrink-0" />
          {alert.label}
        </p>
        {children}
      </div>
    );
  },
  ul: function MarkdownUnorderedList({ node, ...props }) {
    return (
      <MarkdownList node={node}>
        <ul {...props} />
      </MarkdownList>
    );
  },
  ol: function MarkdownOrderedList({ node, start, ...props }) {
    const itemCount =
      node?.children?.filter((child) => child.type === "element" && child.tagName === "li")
        .length ?? 0;

    // The sanitizer strips style attributes, so the gutter var is the list's only style.
    return (
      <MarkdownList node={node}>
        <ol
          {...props}
          start={start}
          style={{ "--list-gutter": orderedListGutter(itemCount, start) }}
        />
      </MarkdownList>
    );
  },
  li: function MarkdownListItem({ node, children, ...props }) {
    const { text, skills } = use(ChatMarkdownRendererContext);
    const listItemStart = node?.position?.start.offset;

    const markerOffset = Predicate.isNumber(listItemStart)
      ? findTaskListMarkerOffset(text, listItemStart)
      : null;

    return (
      <li {...props} data-task-marker-offset={markerOffset ?? undefined}>
        {renderSkillInlineMarkdownChildren(children, skills)}
      </li>
    );
  },
  input: function MarkdownInput({ node: _node, type, checked, disabled: _disabled, ...props }) {
    const { onTaskListChange } = use(ChatMarkdownRendererContext);
    const { t } = useI18n();

    if (type !== "checkbox" || !onTaskListChange) {
      return (
        <input
          {...props}
          type={type}
          checked={checked}
          disabled={_disabled}
          readOnly={type === "checkbox"}
        />
      );
    }

    return (
      <input
        {...props}
        type="checkbox"
        name="markdown-task"
        aria-label={t("Toggle task")}
        checked={checked}
        onChange={(event) => {
          const markerOffset = Number(event.currentTarget.closest("li")?.dataset.taskMarkerOffset);

          if (!Number.isSafeInteger(markerOffset)) return;
          onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
        }}
      />
    );
  },
  a: function MarkdownAnchor({ node, href, children, title: _title, ...props }) {
    const {
      cwd,
      environmentId,
      markdownFileLinkMetaByHref,
      threadRef,
      openExternalLinkInPreview,
      fileLinkChip,
    } = use(ChatMarkdownRendererContext);

    const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
    const settingsDestination = parseSettingsDeepLink(normalizedHref);

    if (settingsDestination) {
      return (
        <SettingsLinkChip
          href={normalizedHref}
          destination={settingsDestination}
          environmentId={environmentId}
          {...(props.className ? { className: props.className } : {})}
        >
          {children}
        </SettingsLinkChip>
      );
    }

    // A malformed in-app link must never reach the OS or a browser tab.
    if (isAppDeepLink(normalizedHref)) return <>{children}</>;

    const fileLinkMeta = normalizedHref
      ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
        resolveMarkdownFileLinkMeta(normalizedHref, cwd))
      : null;

    if (!fileLinkMeta) {
      const faviconHost = resolveExternalWebLinkHost(href);
      const isSameDocumentLink = href?.startsWith("#") ?? false;
      const onClick = props.onClick;
      const canOpenInPreview = Boolean(threadRef) && isPreviewSupportedInRuntime();

      const link = (
        <a
          {...props}
          href={href}
          target={isSameDocumentLink ? undefined : "_blank"}
          rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
          onClick={(event) => {
            onClick?.(event);

            if (isSameDocumentLink && href) {
              handleMarkdownFragmentClick(event, href);
            }
          }}
          onContextMenu={(event) => {
            if (!href || !faviconHost) return;
            event.preventDefault();
            event.stopPropagation();
            const api = readLocalApi();

            if (!api) return;
            void showExternalLinkContextMenu({
              href,
              canOpenInPreview,
              position: { x: event.clientX, y: event.clientY },
              showContextMenu: (items, position) => api.contextMenu.show(items, position),
              openInPreview: async (target) => {
                const result = await openExternalLinkInPreview(target);

                if (Predicate.isTagged(result, "Failure") && !isAtomCommandInterrupted(result)) {
                  reportMarkdownActionFailure(
                    { operation: "open-link-in-preview", target },
                    result.cause,
                  );
                }
              },
              openExternal: (target) => api.shell.openExternal(target),
              copyLink: (target) => writeTextToClipboard(target, "link"),
              reportFailure: (operation, cause) => {
                reportMarkdownActionFailure({ operation, target: href }, cause);
              },
            });
          }}
        >
          {faviconHost && hastHasText(node) ? (
            <MarkdownExternalLinkContent host={faviconHost} plainText={plainHastText(node)}>
              {children}
            </MarkdownExternalLinkContent>
          ) : (
            children
          )}
        </a>
      );

      if (!faviconHost || !href) {
        return link;
      }

      return (
        <Tooltip>
          <TooltipTrigger render={link} />
          <TooltipPopup
            side="top"
            variant="tight"
            className="max-w-(--spacing-min-36rem-vw-2rem) whitespace-normal wrap-anywhere"
          >
            {href}
          </TooltipPopup>
        </Tooltip>
      );
    }

    return fileLinkChip(
      fileLinkMeta,
      `[${fileLinkMeta.basename}](${normalizedHref})`,
      props.className,
    );
  },
  code: function MarkdownCode({ node, children, className, ...props }) {
    const { cwd, inlineCodeFileLinkMetaByText, fileLinkChip } = use(ChatMarkdownRendererContext);
    const mathExpression = node?.properties?.dataMathExpression;

    if (Predicate.isString(mathExpression)) {
      return <MarkdownMathExpression expression={mathExpression} displayMode={false} />;
    }

    if (node?.properties?.dataInlineCode != null) {
      const codeText = nodeToPlainText(children);

      const fileLinkMeta =
        inlineCodeFileLinkMetaByText.get(codeText.trim()) ??
        resolveInlineCodeFileLinkMeta(codeText, cwd);

      if (fileLinkMeta) {
        return fileLinkChip(fileLinkMeta, `\`${codeText}\``);
      }
    }

    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  },
  img: function MarkdownImage({ node: _node, title: _title, src, alt, ...props }) {
    const { cwd, threadRef } = use(ChatMarkdownRendererContext);
    const srcString = Predicate.isString(src) ? normalizeMarkdownLinkDestination(src) : "";
    const altText = alt ?? "";
    const imageSource = classifyMarkdownImageSource(srcString, cwd);

    if (Predicate.isTagged(imageSource, "Direct")) {
      return (
        <img
          {...props}
          src={imageSource.uri}
          alt={altText}
          loading="lazy"
          className={cn(props.className, CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME)}
        />
      );
    }

    if (Predicate.isTagged(imageSource, "WorkspaceFile") && threadRef) {
      return (
        <ChatMarkdownWorkspaceImage threadRef={threadRef} path={imageSource.path} alt={altText} />
      );
    }

    return <ChatMarkdownImageFallback alt={altText} />;
  },
  table: function MarkdownTableRenderer({ node: _node, ...props }) {
    return <MarkdownTable {...props} />;
  },
  details: function MarkdownDetailsRenderer({ node: _node, children, open: detailsOpen }) {
    return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const { resolvedTheme, diffThemeName, isStreaming } = use(ChatMarkdownRendererContext);
    const codeBlock = extractCodeBlock(children);

    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }

    const language = extractFenceLanguage(codeBlock.className);

    if (language.toLowerCase() === "math") {
      return <MarkdownMathExpression expression={codeBlock.code} displayMode />;
    }

    if (language.toLowerCase() === "mermaid") {
      return <MarkdownMermaidDiagram code={codeBlock.code} theme={resolvedTheme} />;
    }

    const generativeKind = generativeKindForLanguage(language);

    if (generativeKind) {
      const block = decodeGenerativeBlock(generativeKind, codeBlock.code);

      if (block) return <GenerativeBlock block={block} />;

      if (isStreaming) return <GenerativeBlockPending />;
    }

    const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));

    if (MARKDOWN_DIFF_LANGUAGES.has(language.toLowerCase())) {
      return (
        <MarkdownDiffBlock
          code={codeBlock.code}
          language={language}
          fenceTitle={fenceTitle}
          theme={resolvedTheme}
        />
      );
    }

    return (
      <MarkdownCodeBlock
        code={codeBlock.code}
        language={language}
        fenceTitle={fenceTitle}
        theme={resolvedTheme}
      >
        <RenderErrorBoundary fallback={<pre {...props}>{children}</pre>}>
          <Suspense fallback={<pre {...props}>{children}</pre>}>
            <SuspenseShikiCodeBlock
              className={codeBlock.className}
              code={codeBlock.code}
              themeName={diffThemeName}
              isStreaming={isStreaming}
            />
          </Suspense>
        </RenderErrorBoundary>
      </MarkdownCodeBlock>
    );
  },
};

function ChatMarkdown({
  text,
  className,
  lineBreaks = false,
  parseRawHtml = true,
  ...props
}: ChatMarkdownProps) {
  // Streaming frames drop unstable trailing tokens; the result is always a
  // prefix of the text, so task marker offsets stay valid.
  const renderedText = props.isStreaming ? stabilizeStreamingMarkdown(text) : text;

  const { componentState, handleCopy, markdownUrlTransform } = useChatMarkdownState({
    text: renderedText,
    ...props,
  });

  // react-markdown converts unparsed HTML nodes to text when skipHtml is false.
  // Keep that behavior explicit because literal mode depends on escaping the
  // complete source token instead of dropping it from the rendered message.
  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80 wrap-anywhere word-break-word",
        className,
      )}
      onCopy={handleCopy}
    >
      <ChatMarkdownRendererContext value={componentState}>
        <ReactMarkdown
          remarkPlugins={
            lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS
          }
          rehypePlugins={parseRawHtml ? CHAT_MARKDOWN_REHYPE_PLUGINS_WITH_RAW_HTML : undefined}
          skipHtml={false}
          components={CHAT_MARKDOWN_COMPONENTS}
          urlTransform={markdownUrlTransform}
        >
          {renderedText}
        </ReactMarkdown>
      </ChatMarkdownRendererContext>
    </div>
  );
}

export default memo(ChatMarkdown);

export { orderedListGutter, taskListProgress } from "./markdown/MarkdownLists";

export {
  canUseMarkdownFileShellActions,
  EMPTY_MARKDOWN_SKILLS,
  hasMarkdownFilePrimaryAction,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./markdown/markdownFileActions";

export { nodeToPlainText } from "./markdown/markdownText";
