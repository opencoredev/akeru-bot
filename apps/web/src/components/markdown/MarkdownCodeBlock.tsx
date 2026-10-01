import katex from "katex";
import { CheckIcon, CopyIcon, WrapTextIcon } from "lucide-react";
import {
  Children,
  isValidElement,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getClientSettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import { fnv1a32, type DiffThemeName } from "../../lib/diffRendering";
import { LRUCache } from "../../lib/lruCache";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { parseMarkdownDiff } from "../../markdownDiff";
import {
  hasSpecificPierreIconForFileName,
  syntheticFileNameForLanguageId,
} from "../../pierre-icons";
import { DiffStatLabel, hasNonZeroStat } from "../chat/DiffStatLabel";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import { nodeToPlainText } from "./markdownText";

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;

const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;

const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;

const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);

export function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";

  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;

const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

/** Pulls a filename out of fence meta: ```ts title="x.ts" / ```ts src/main.ts */
export function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null;
  const attrMatch = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const attrTitle = attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3];

  if (attrTitle) return attrTitle;

  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate)) ?? null;
}

export function extractPreCodeMeta(node: unknown): string | undefined {
  const children = (
    node as
      | {
          children?: Array<{
            type?: string;
            tagName?: string;
            data?: { meta?: unknown };
            properties?: { dataCodeMeta?: unknown };
          }>;
        }
      | undefined
  )?.children;

  const codeNode = children?.find((child) => child?.type === "element" && child.tagName === "code");
  const meta = codeNode?.properties?.dataCodeMeta ?? codeNode?.data?.meta;

  return typeof meta === "string" && meta.trim().length > 0 ? meta.trim() : undefined;
}

export function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);

  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];

  if (
    !isValidElement<{ className?: string; children?: ReactNode; node?: { tagName?: string } }>(
      onlyChild,
    )
  ) {
    return null;
  }

  // With a custom `code` component the child's type is that component, not
  // the "code" tag — the hast node react-markdown attaches still names it.
  if (onlyChild.type !== "code" && onlyChild.props.node?.tagName !== "code") {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

export function readInitialWordWrapSetting(): boolean {
  return getClientSettings().wordWrap;
}

export function MarkdownMathExpression({
  expression,
  displayMode,
}: {
  readonly expression: string;
  readonly displayMode: boolean;
}) {
  const html = katex.renderToString(expression, {
    displayMode,
    output: "htmlAndMathml",
    strict: "warn",
    throwOnError: false,
    trust: false,
  });

  return (
    <span
      className={displayMode ? "chat-markdown-math-block" : "chat-markdown-math-inline"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function MarkdownMermaidDiagram({
  code,
  theme,
}: {
  readonly code: string;
  readonly theme: "light" | "dark";
}) {
  const { t } = useI18n();
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setSvg(null);
    setFailed(false);

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "default",
        });
        const result = await mermaid.render(`mermaid-${reactId.replaceAll(":", "")}`, code);

        if (active) setSvg(result.svg);
      })
      .catch((cause: unknown) => {
        reportMarkdownActionFailure({ operation: "render-mermaid", language: "mermaid" }, cause);

        if (active) setFailed(true);
      });

    return () => {
      active = false;
    };
  }, [code, reactId, theme]);

  return (
    <div
      className="chat-markdown-mermaid my-3 overflow-x-auto rounded-lg border border-border bg-muted/20 p-3"
      data-mermaid-diagram=""
    >
      {svg ? (
        <div
          aria-label={t("Mermaid diagram")}
          role="img"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : failed ? (
        <pre className="m-0">
          <code className="language-mermaid">{code}</code>
        </pre>
      ) : (
        <p className="m-0 text-xs text-muted-foreground">{t("Rendering diagram…")}</p>
      )}
    </div>
  );
}

/**
 * Filename titles render icon + text; language-only titles render just the
 * icon (redundant next to its own name) and fall back to the language text
 * when no specific icon exists or it fails to load.
 */
function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
  theme,
}: {
  fenceTitle: string | null;
  language: string;
  theme: "light" | "dark";
}) {
  const { t } = useI18n();

  if (fenceTitle) {
    return (
      <>
        <PierreEntryIcon pathValue={fenceTitle} kind="file" theme={theme} className="size-3.5" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }

  const fileName = syntheticFileNameForLanguageId(language);

  if (!hasSpecificPierreIconForFileName(fileName)) {
    return <span className="truncate">{language}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex shrink-0 rounded-sm"
            aria-label={t("Language: {language}", { language })}
          />
        }
      >
        <PierreEntryIcon pathValue={fileName} kind="file" theme={theme} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{language}</TooltipPopup>
    </Tooltip>
  );
}

export function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  headerDetail,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  /** Extra header content after the title, such as diff line counts. */
  headerDetail?: ReactNode;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(readInitialWordWrapSetting);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useI18n();
  const wrapLabel = wrapped ? t("Disable line wrap") : t("Wrap lines");
  const copyLabel = copied ? t("Copied") : t("Copy code");

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }

    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }

        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure(
          {
            operation: "copy-code-block",
            language,
            ...(fenceTitle ? { fenceTitle } : {}),
          },
          cause,
        );
      });
  }, [code, fenceTitle, language]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-[var(--radius)] border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none">
        <span className="inline-flex min-w-0 items-center gap-[0.4rem] [font-family:var(--font-mono,ui-monospace,SFMono-Regular,monospace)] [font-size:0.6875rem]">
          <MarkdownCodeBlockTitleContent
            fenceTitle={fenceTitle}
            language={language}
            theme={theme}
          />
          {headerDetail}
        </span>
        <span
          className="flex items-center gap-0.5"
          role="toolbar"
          aria-label={t("Code block actions")}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={wrapped}
                  onClick={() => setWrapped((value) => !value)}
                  aria-label={wrapLabel}
                />
              }
            >
              <WrapTextIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      {children}
    </div>
  );
}

function diffBlockTitle(fenceTitle: string | null, files: ReadonlyArray<string>): string | null {
  if (fenceTitle) return fenceTitle;

  if (files.length === 1) return files[0] ?? null;

  return null;
}

/**
 * ```diff and ```patch fences render as a change card: per-line add/remove
 * tints and a header with the file and line counts. Parsing is line-local, so
 * a streaming diff never repaints lines that already arrived.
 */
export function MarkdownDiffBlock({
  code,
  language,
  fenceTitle,
  theme,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
}) {
  const diff = useMemo(() => parseMarkdownDiff(code), [code]);
  const title = diffBlockTitle(fenceTitle, diff.files);
  const fileCount = diff.files.length > 1 ? `${diff.files.length} files` : null;

  return (
    <MarkdownCodeBlock
      code={code}
      language={language}
      fenceTitle={title}
      theme={theme}
      headerDetail={
        <>
          {fileCount ? <span className="shrink-0">{fileCount}</span> : null}
          {hasNonZeroStat(diff) ? (
            <DiffStatLabel
              additions={diff.additions}
              deletions={diff.deletions}
              layout="inline"
              className="shrink-0"
            />
          ) : null}
        </>
      }
    >
      <pre className="chat-markdown-diff">
        <code>
          {diff.lines.map((line, index) => (
            // Lines never reorder, so the index is a stable key while streaming.
            // oxlint-disable-next-line react/no-array-index-key
            <span key={index} className="chat-markdown-diff-line" data-diff-line={line.kind}>
              {line.text}
            </span>
          ))}
        </code>
      </pre>
    </MarkdownCodeBlock>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

export function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getSyntaxHighlighterPromise(language));

  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );

      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}
