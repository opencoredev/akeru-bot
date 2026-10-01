import { Predicate } from "effect";
import { isAppDeepLink } from "@akeru/client-runtime/settings-deep-link";
import type { EnvironmentId, ScopedThreadRef, ServerProviderSkill } from "@akeru/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, type ClipboardEvent as ReactClipboardEvent } from "react";
import { defaultUrlTransform } from "react-markdown";
import {
  BrowserPreviewUnavailableError,
  isBrowserPreviewFile,
  openFileInPreview,
  openUrlInPreview,
} from "../../browser/openFileInPreview";
import { recordVisitForThread } from "../../browserHistoryStore";
import { openInEditorMenuLabel } from "../../editorLabels";
import {
  PreferredEditorEnvironmentRequiredError,
  useOpenInPreferredEditor,
  usePreferredEditor,
} from "../../editorPreferences";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { useLocalShellAccess } from "../../localShellAccess";
import { chatMarkdownClipboardPayload } from "../../markdown-clipboard";
import {
  extractMarkdownLinkHrefs,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../../markdown-links";
import { isPreviewSupportedInRuntime } from "../../previewStateStore";
import { assetEnvironment } from "../../state/assets";
import { previewEnvironment } from "../../state/preview";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { usePreparedConnection } from "../../state/session";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { resolvePathLinkTarget } from "../../terminal-links";
import {
  needsWorkspaceBasenameLookup,
  pickWorkspaceBasenameMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "../../workspaceBasenameLookup";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "../preview/fileExplorerLabel";
import { canUseMarkdownFileShellActions, EMPTY_MARKDOWN_SKILLS } from "./markdownFileActions";
import { buildFileLinkParentSuffixByPath, MarkdownFileLink } from "./MarkdownFileLink";
import { normalizeMarkdownLinkHrefKey } from "./MarkdownLinks";

export interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  /** Environment that owns markdown rendered outside a thread. */
  environmentId?: EnvironmentId | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName" | "icon">>;
  className?: string;
  /** Treat single newlines as hard breaks — chat-style user input. */
  lineBreaks?: boolean;
  /** Parse sanitized raw HTML instead of displaying its source text. */
  parseRawHtml?: boolean;
}

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?(?:```|$))/;

const INLINE_CODE_SPAN_PATTERN = /`([^`\n]+)`/g;

function extractInlineCodeSpans(text: string): string[] {
  const spans: string[] = [];
  const segments = text.split(FENCED_CODE_SEGMENT_PATTERN);

  for (let index = 0; index < segments.length; index += 2) {
    for (const match of (segments[index] ?? "").matchAll(INLINE_CODE_SPAN_PATTERN)) {
      const span = match[1]?.trim();

      if (span) spans.push(span);
    }
  }

  return spans;
}

export function useChatMarkdownState({
  text,
  cwd,
  threadRef,
  environmentId: explicitEnvironmentId,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();

  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });

  const searchProjectEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });

  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });

  const environmentId = threadRef?.environmentId ?? explicitEnvironmentId ?? null;
  const shellAccess = useLocalShellAccess(environmentId);
  const canUseShellActions = canUseMarkdownFileShellActions(environmentId, shellAccess);
  const preparedConnection = usePreparedConnection(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const availableEditors = serverConfig?.availableEditors ?? [];
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const preferredEditorMenuLabel = openInEditorMenuLabel(preferredEditor);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);

  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });

  const revealInFileManagerLabel =
    environmentId !== null &&
    serverConfig?.shellRevealInFileManager === true &&
    serverConfig.availableEditors.includes("file-manager")
      ? serverConfig.shellRevealInFileManagerKind === undefined
        ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
        : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
      : undefined;

  const revealFileInFileManager = useCallback(
    (filePath: string) => {
      if (environmentId === null) {
        return Promise.resolve(
          AsyncResult.failure<void, PreferredEditorEnvironmentRequiredError>(
            Cause.fail(new PreferredEditorEnvironmentRequiredError({ targetPath: filePath })),
          ),
        );
      }

      return openInEditor({
        environmentId,
        input: { cwd: filePath, editor: "file-manager", reveal: true },
      });
    },
    [environmentId, openInEditor],
  );

  const diffThemeName = resolveDiffThemeName(resolvedTheme);

  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();

    for (const href of extractMarkdownLinkHrefs(text)) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);

      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd);

      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }

    return metaByHref;
  }, [cwd, text]);

  const inlineCodeFileLinkMetaByText = useMemo(() => {
    const metaByText = new Map<string, MarkdownFileLinkMeta>();

    for (const span of extractInlineCodeSpans(text)) {
      if (metaByText.has(span)) continue;
      const meta = resolveInlineCodeFileLinkMeta(span, cwd);

      if (meta) {
        metaByText.set(span, meta);
      }
    }

    return metaByText;
  }, [cwd, text]);

  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [
      ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
      ...[...inlineCodeFileLinkMetaByText.values()].map((meta) => meta.filePath),
    ];

    return buildFileLinkParentSuffixByPath(filePaths);
  }, [inlineCodeFileLinkMetaByText, markdownFileLinkMetaByHref]);

  const markdownUrlTransform = useCallback((href: string) => {
    // Keep in-app links intact so the renderer can show a chip or swallow them.
    if (isAppDeepLink(href)) return href;

    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);

  // Re-emit highlighted content as markdown so copying out of the rendered
  // view keeps links, emphasis, lists, and code fences intact.
  const handleCopy = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();

    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);

    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
  }, []);

  const openExternalLinkInPreview = useCallback(
    (url: string) => {
      if (!threadRef) {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: "Chat context is unavailable.",
              }),
            ),
          ),
        );
      }

      return openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
        if (Predicate.isTagged(result, "Success")) recordVisitForThread(threadRef, url);

        return result;
      });
    },
    [openPreview, threadRef],
  );

  const openMarkdownFileInPreview = useCallback(
    (path: string) => {
      if (!threadRef || Predicate.isTagged(preparedConnection, "None")) {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: "Environment is not connected.",
              }),
            ),
          ),
        );
      }

      return openFileInPreview({
        threadRef,
        filePath: path,
        httpBaseUrl: preparedConnection.value.httpBaseUrl,
        createAssetUrl,
        openPreview,
      });
    },
    [createAssetUrl, openPreview, preparedConnection, threadRef],
  );

  const findWorkspaceBasenameMatch = useCallback(
    async (workspaceRelativePath: string) => {
      if (!cwd || environmentId === null || !needsWorkspaceBasenameLookup(workspaceRelativePath)) {
        return null;
      }

      const result = await searchProjectEntries({
        environmentId,
        input: {
          cwd,
          query: workspaceRelativePath,
          limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
          kind: "file",
        },
      });

      return Predicate.isTagged(result, "Success")
        ? pickWorkspaceBasenameMatch(workspaceRelativePath, result.value.entries)
        : null;
    },
    [cwd, environmentId, searchProjectEntries],
  );

  // A bare filename resolves to the workspace root, which is rarely where the
  // file is, so ask the index before opening it in the editor.
  const openMarkdownFileInEditor = useCallback(
    async (fileLinkMeta: MarkdownFileLinkMeta) => {
      const workspaceRelativePath = fileLinkMeta.workspaceRelativePath;

      const match = workspaceRelativePath
        ? await findWorkspaceBasenameMatch(workspaceRelativePath)
        : null;

      if (!match || !cwd) return openInPreferredEditor(fileLinkMeta.targetPath);

      const position = fileLinkMeta.line
        ? `:${fileLinkMeta.line}${fileLinkMeta.column ? `:${fileLinkMeta.column}` : ""}`
        : "";

      return openInPreferredEditor(`${resolvePathLinkTarget(match, cwd)}${position}`);
    },
    [cwd, findWorkspaceBasenameMatch, openInPreferredEditor],
  );

  const revealMarkdownFileInFileManager = useCallback(
    async (fileLinkMeta: MarkdownFileLinkMeta) => {
      const workspaceRelativePath = fileLinkMeta.workspaceRelativePath;

      const match = workspaceRelativePath
        ? await findWorkspaceBasenameMatch(workspaceRelativePath)
        : null;

      const filePath = match && cwd ? resolvePathLinkTarget(match, cwd) : fileLinkMeta.filePath;

      return revealFileInFileManager(filePath);
    },
    [cwd, findWorkspaceBasenameMatch, revealFileInFileManager],
  );

  const fileLinkChip = useCallback(
    (fileLinkMeta: MarkdownFileLinkMeta, copyMarkdown: string, className?: string) => {
      const parentSuffix = fileLinkParentSuffixByPath.get(
        fileLinkMeta.filePath.replaceAll("\\", "/"),
      );

      const labelParts = [fileLinkMeta.basename];

      if (Predicate.isString(parentSuffix) && parentSuffix.length > 0) {
        labelParts.push(parentSuffix);
      }

      if (fileLinkMeta.line) {
        labelParts.push(
          `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ""}`,
        );
      }

      return (
        <MarkdownFileLink
          href={fileLinkMeta.targetPath}
          targetPath={fileLinkMeta.targetPath}
          iconPath={fileLinkMeta.filePath}
          displayPath={fileLinkMeta.displayPath}
          label={labelParts.join(" · ")}
          copyMarkdown={copyMarkdown}
          theme={resolvedTheme}
          {...(canUseShellActions ? { onOpen: () => openMarkdownFileInEditor(fileLinkMeta) } : {})}
          openInEditorMenuLabel={preferredEditorMenuLabel}
          onReveal={
            canUseShellActions && revealInFileManagerLabel !== undefined
              ? () => revealMarkdownFileInFileManager(fileLinkMeta)
              : undefined
          }
          revealLabel={revealInFileManagerLabel}
          onOpenInBrowser={
            threadRef &&
            isPreviewSupportedInRuntime() &&
            isBrowserPreviewFile(fileLinkMeta.filePath)
              ? () => openMarkdownFileInPreview(fileLinkMeta.filePath)
              : undefined
          }
          className={className}
        />
      );
    },
    [
      canUseShellActions,
      fileLinkParentSuffixByPath,
      openMarkdownFileInEditor,
      openMarkdownFileInPreview,
      preferredEditorMenuLabel,
      resolvedTheme,
      revealInFileManagerLabel,
      revealMarkdownFileInFileManager,
      threadRef,
    ],
  );

  const componentState = useMemo(
    () => ({
      cwd,
      diffThemeName,
      environmentId,
      fileLinkChip,
      inlineCodeFileLinkMetaByText,
      isStreaming,
      markdownFileLinkMetaByHref,
      onTaskListChange,
      openExternalLinkInPreview,
      resolvedTheme,
      skills,
      text,
      threadRef,
    }),
    [
      cwd,
      diffThemeName,
      environmentId,
      fileLinkChip,
      inlineCodeFileLinkMetaByText,
      isStreaming,
      markdownFileLinkMetaByHref,
      onTaskListChange,
      openExternalLinkInPreview,
      resolvedTheme,
      skills,
      text,
      threadRef,
    ],
  );

  return {
    componentState,
    handleCopy,
    markdownUrlTransform,
  };
}

export { reportMarkdownActionFailure } from "./markdownActionFailure";

export { WINDOWS_DRIVE_PATH_REGEX } from "./markdownPaths";
