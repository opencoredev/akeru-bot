import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@akeru/client-runtime/state/runtime";
import { memo, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { shouldOpenMarkdownFileLinkInEditor } from "../../markdown-links";
import { CHAT_FILE_TAG_CHIP_CLASS_NAME, FileTagChipContent } from "../chat/FileTagChip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import {
  hasMarkdownFilePrimaryAction,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./markdownFileActions";

interface MarkdownFileLinkProps {
  href: string;
  targetPath: string;
  iconPath: string;
  displayPath: string;
  label: string;
  copyMarkdown: string;
  theme: "light" | "dark";
  onOpen?: ((targetPath: string) => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  openInEditorMenuLabel: string;
  onOpenInBrowser?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  onReveal?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  /** Platform-specific menu label ("Reveal in Finder", ...); required for the
      reveal item to show. */
  revealLabel?: string | undefined;
  className?: string | undefined;
}

const MARKDOWN_FILE_CHIP_CLASS_NAME = "chat-markdown-file-link";

const MARKDOWN_FILE_LINK_CLASS_NAME = `${MARKDOWN_FILE_CHIP_CLASS_NAME} cursor-pointer transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70`;

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);

  return segments.slice(0, -1);
}

export function buildFileLinkParentSuffixByPath(
  filePaths: ReadonlyArray<string>,
): Map<string, string> {
  const groups = new Map<string, Set<string>>();

  for (const filePath of filePaths) {
    const normalizedPath = filePath.replaceAll("\\", "/");
    const pathSegments = normalizedPath.split("/").filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];

    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(normalizedPath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();

  for (const group of groups.values()) {
    const uniquePaths = [...group];

    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );

    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;

      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");

        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];

          return otherSegments.slice(-depth).join("/") === candidate;
        });

        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }

      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];

      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

export const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  iconPath,
  displayPath,
  label,
  copyMarkdown,
  theme,
  onOpen,
  openInEditorMenuLabel,
  onOpenInBrowser,
  onReveal,
  revealLabel,
  className,
}: MarkdownFileLinkProps) {
  const { t } = useI18n();

  const handleOpenInEditor = useCallback(() => {
    if (!onOpen) {
      return;
    }

    void (async () => {
      try {
        const result = await onOpen(targetPath);

        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }

        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to open file"),
            description: error instanceof Error ? error.message : t("An error occurred."),
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to open file"),
            description: cause instanceof Error ? cause.message : t("An error occurred."),
          }),
        );
      }
    })();
  }, [onOpen, t, targetPath]);

  const handleOpenInBrowser = useCallback(() => {
    if (!onOpenInBrowser) {
      return;
    }

    void (async () => {
      try {
        const result = await onOpenInBrowser();

        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }

        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to open file in browser"),
            description: error instanceof Error ? error.message : t("An error occurred."),
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to open file in browser"),
            description: cause instanceof Error ? cause.message : t("An error occurred."),
          }),
        );
      }
    })();
  }, [onOpenInBrowser, t, targetPath]);

  const handleRevealInFileManager = useCallback(() => {
    if (!onReveal) {
      return;
    }

    void (async () => {
      try {
        const result = await onReveal();

        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }

        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to reveal file"),
            description: error instanceof Error ? error.message : t("An error occurred."),
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to reveal file"),
            description: cause instanceof Error ? cause.message : t("An error occurred."),
          }),
        );
      }
    })();
  }, [onReveal, t, targetPath]);

  const handleCopy = useCallback(
    (value: string, copyTarget: "Relative path" | "Full path") => {
      const failedTitle =
        copyTarget === "Relative path"
          ? t("Failed to copy relative path")
          : t("Failed to copy full path");

      if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failedTitle,
            description: t("Clipboard API unavailable."),
          }),
        );

        return;
      }

      void navigator.clipboard.writeText(value).then(
        () => {
          toastManager.add({
            type: "success",
            title:
              copyTarget === "Relative path" ? t("Relative path copied") : t("Full path copied"),
            description: value,
          });
        },
        (error) => {
          reportMarkdownActionFailure(
            { operation: "copy-file-path", target: targetPath, copyTarget },
            error,
          );
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: failedTitle,
              description: error instanceof Error ? error.message : t("An error occurred."),
            }),
          );
        },
      );
    },
    [t, targetPath],
  );

  const showFileContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();

      if (!api) return;

      try {
        const clicked = await api.contextMenu.show(
          [
            ...(onOpen ? ([{ id: "open", label: openInEditorMenuLabel }] as const) : []),
            ...(onOpenInBrowser
              ? ([{ id: "open-in-browser", label: t("Open in integrated browser") }] as const)
              : []),
            ...(onReveal && revealLabel ? ([{ id: "reveal", label: revealLabel }] as const) : []),
            { id: "copy-relative", label: t("Copy relative path") },
            { id: "copy-full", label: t("Copy full path") },
          ] as const,
          position,
        );

        if (clicked === "open") {
          handleOpenInEditor();

          return;
        }

        if (clicked === "open-in-browser") {
          handleOpenInBrowser();

          return;
        }

        if (clicked === "reveal") {
          handleRevealInFileManager();

          return;
        }

        if (clicked === "copy-relative") {
          handleCopy(displayPath, "Relative path");

          return;
        }

        if (clicked === "copy-full") {
          handleCopy(targetPath, "Full path");
        }
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "show-file-context-menu", target: targetPath },
          cause,
        );
      }
    },
    [
      displayPath,
      handleCopy,
      handleOpenInBrowser,
      handleOpenInEditor,
      handleRevealInFileManager,
      onOpenInBrowser,
      onOpen,
      onReveal,
      openInEditorMenuLabel,
      revealLabel,
      t,
      targetPath,
    ],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const position =
        event.clientX === 0 && event.clientY === 0
          ? (() => {
              const bounds = event.currentTarget.getBoundingClientRect();

              return { x: bounds.left, y: bounds.bottom };
            })()
          : { x: event.clientX, y: event.clientY };

      void showFileContextMenu(position);
    },
    [showFileContextMenu],
  );

  const canOpenInEditor = onOpen !== undefined;
  const canOpenInBrowser = onOpenInBrowser !== undefined;
  const hasPrimaryAction = hasMarkdownFilePrimaryAction({ canOpenInEditor, canOpenInBrowser });

  const useBrowserPrimaryAction = shouldUseMarkdownFileBrowserPrimaryAction({
    iconPath,
    canOpenInEditor,
    canOpenInBrowser,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          hasPrimaryAction ? (
            <a
              href={href}
              className={cn(
                CHAT_FILE_TAG_CHIP_CLASS_NAME,
                MARKDOWN_FILE_LINK_CLASS_NAME,
                className,
              )}
              data-markdown-copy={copyMarkdown}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();

                if (useBrowserPrimaryAction && !shouldOpenMarkdownFileLinkInEditor(event)) {
                  handleOpenInBrowser();

                  return;
                }

                if (onOpen) {
                  handleOpenInEditor();

                  return;
                }

                handleOpenInBrowser();
              }}
              onContextMenu={handleContextMenu}
            >
              <FileTagChipContent path={iconPath} label={label} theme={theme} selectable />
            </a>
          ) : (
            <button
              type="button"
              aria-label={t("File options for {label}", { label })}
              aria-haspopup="menu"
              className={cn(
                CHAT_FILE_TAG_CHIP_CLASS_NAME,
                MARKDOWN_FILE_LINK_CLASS_NAME,
                "select-text",
                className,
              )}
              data-markdown-copy={copyMarkdown}
              onClick={handleContextMenu}
              onContextMenu={handleContextMenu}
            >
              <FileTagChipContent path={iconPath} label={label} theme={theme} selectable />
            </button>
          )
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        {/* The full path: the chip already shows the shortened form, and a link
            to the workspace root collapses to a bare label that repeats it. */}
        <div className="overflow-x-auto whitespace-nowrap [scrollbar-color:color-mix(in_srgb,var(--contrast-border)_78%,transparent)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--contrast-border)_78%,transparent)] [&::-webkit-scrollbar-track]:bg-transparent">
          {targetPath}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.href === next.href &&
    previous.targetPath === next.targetPath &&
    previous.iconPath === next.iconPath &&
    previous.displayPath === next.displayPath &&
    previous.label === next.label &&
    previous.copyMarkdown === next.copyMarkdown &&
    previous.theme === next.theme &&
    previous.onOpen === next.onOpen &&
    previous.openInEditorMenuLabel === next.openInEditorMenuLabel &&
    previous.onOpenInBrowser === next.onOpenInBrowser &&
    previous.onReveal === next.onReveal &&
    previous.revealLabel === next.revealLabel &&
    previous.className === next.className
  );
}
