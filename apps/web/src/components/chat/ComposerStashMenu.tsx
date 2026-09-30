import { BookmarkIcon, FileTextIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useI18n } from "~/i18n";
import { cn } from "~/lib/utils";
import { type PromptStashEntry } from "../../promptStashStore";
import { ComposerBanner } from "./ComposerBanner";

const SNIPPET_MAX_CHARS = 90;

/** Images that did not make it into the entry, whatever the reason. */
function missingImageCount(entry: PromptStashEntry): number {
  return entry.droppedImageNames.length + (entry.unreadableImageNames?.length ?? 0);
}

function stashEntrySnippet(
  entry: PromptStashEntry,
  t: ReturnType<typeof useI18n>["t"],
  plural: ReturnType<typeof useI18n>["plural"],
): string {
  const trimmed = entry.prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length > 0) {
    return trimmed.length > SNIPPET_MAX_CHARS ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…` : trimmed;
  }
  const imageCount = entry.attachments.length + entry.droppedImageNames.length;
  return imageCount > 0
    ? plural(imageCount, { one: "({count} image)", other: "({count} images)" })
    : t("(empty)");
}

/**
 * Attached banner listing the stashed prompts. Keyboard-first: opened by ⌘S on an
 * empty composer, navigated with arrows, restored with Enter, dismissed
 * with Escape. The listener runs capture-phase on window so it wins over
 * the Lexical editor's handlers while the menu is open.
 */
export const ComposerStashMenu = memo(function ComposerStashMenu(props: {
  entries: ReadonlyArray<PromptStashEntry>;
  stashShortcutLabel?: string | null;
  onRestore: (entry: PromptStashEntry) => void;
  onDelete: (entry: PromptStashEntry) => void;
  onClose: () => void;
}) {
  const { entries, stashShortcutLabel = null, onRestore, onDelete, onClose } = props;
  const { t, plural } = useI18n();
  const snippets = entries.map((entry) => stashEntrySnippet(entry, t, plural));
  const drawerRef = useRef<HTMLDivElement>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(entries[0]?.id ?? null);

  const highlightedEntry = entries.find((entry) => entry.id === highlightedId) ?? entries[0];

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const drawer = drawerRef.current;
      if (
        (drawer && event.composedPath().includes(drawer)) ||
        (event.target instanceof Element &&
          event.target.closest('[data-prompt-stash-badge="true"]'))
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [onClose]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (entries.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = entries.findIndex((entry) => entry.id === highlightedEntry?.id);
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const normalizedIndex = currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0;
        const nextIndex = (normalizedIndex + offset + entries.length) % entries.length;
        setHighlightedId(entries[nextIndex]?.id ?? null);
        const nextButton =
          drawerRef.current?.querySelectorAll<HTMLButtonElement>("[data-stash-restore]")[nextIndex];
        nextButton?.scrollIntoView({ block: "nearest" });
        if (drawerRef.current?.contains(document.activeElement)) {
          nextButton?.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key === "Enter") {
        // A focused control inside the row (the delete button) owns its own
        // activation; swallowing Enter here would restore instead of delete.
        if (event.target instanceof HTMLElement && event.target.closest("button[aria-label]")) {
          return;
        }
        if (!highlightedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onRestore(highlightedEntry);
        return;
      }
      if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
        if (!highlightedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onDelete(highlightedEntry);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [entries, highlightedEntry, onClose, onDelete, onRestore]);

  return (
    <ComposerBanner.Root ref={drawerRef} data-composer-stash-drawer="true">
      <ComposerBanner.Row
        render={<button type="button" />}
        aria-label={t("Close stash")}
        aria-expanded="true"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onClose}
      >
        <ComposerBanner.Icon>
          <BookmarkIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="text-muted-foreground">
          {t("Stash")}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <ComposerBanner.Count>{entries.length}</ComposerBanner.Count>
          <ComposerBanner.ToggleIcon expanded />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <ComposerBanner.Scroll>
        <ComposerBanner.Children render={<ul role="list" />} aria-label={t("Stashed prompts")}>
          {entries.length === 0 ? (
            <ComposerBanner.Row render={<li />}>
              <ComposerBanner.Icon />
              <ComposerBanner.Content className="text-muted-foreground">
                {stashShortcutLabel
                  ? t(
                      "Nothing stashed yet. Press {shortcut} with a prompt in the composer to stash it.",
                      { shortcut: stashShortcutLabel },
                    )
                  : t("Nothing stashed yet.")}
              </ComposerBanner.Content>
            </ComposerBanner.Row>
          ) : (
            entries.map((entry, index) => (
              <ComposerBanner.Row
                render={<li />}
                key={entry.id}
                data-stash-entry={entry.id}
                data-highlighted={highlightedEntry?.id === entry.id || undefined}
                className={cn(
                  "relative rounded-sm",
                  highlightedEntry?.id === entry.id && "bg-accent text-accent-foreground",
                )}
                onMouseMove={() => {
                  if (highlightedId !== entry.id) setHighlightedId(entry.id);
                }}
                onFocus={() => setHighlightedId(entry.id)}
              >
                <ComposerBanner.Icon>
                  <FileTextIcon />
                </ComposerBanner.Icon>
                <ComposerBanner.Content>
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-foreground/80 outline-none before:absolute before:inset-0 before:rounded-sm focus-visible:before:ring-2 focus-visible:before:ring-ring"
                    data-stash-restore={entry.id}
                    aria-label={t("Restore stashed prompt: {snippet}", {
                      snippet: snippets[index] ?? "",
                    })}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onRestore(entry)}
                  >
                    {snippets[index]}
                  </button>
                </ComposerBanner.Content>
                <ComposerBanner.Actions>
                  {entry.pendingImageCount ? (
                    <span className="shrink-0 text-muted-foreground">
                      {plural(entry.pendingImageCount, {
                        one: "saving {count} image…",
                        other: "saving {count} images…",
                      })}
                    </span>
                  ) : missingImageCount(entry) > 0 ? (
                    <span className="shrink-0 text-warning-foreground">
                      {plural(missingImageCount(entry), {
                        one: "{count} image dropped",
                        other: "{count} images dropped",
                      })}
                    </span>
                  ) : null}
                  {entry.attachments.length > 0 ? (
                    <span className="flex shrink-0 items-center -space-x-1.5">
                      {entry.attachments.slice(0, 3).map((attachment) => (
                        <img
                          key={attachment.id}
                          src={attachment.dataUrl}
                          alt=""
                          aria-hidden="true"
                          className="size-4 rounded border border-border/70 object-cover"
                        />
                      ))}
                    </span>
                  ) : null}
                  <time
                    dateTime={entry.createdAt}
                    className="shrink-0 text-muted-foreground tabular-nums max-sm:hidden"
                  >
                    {formatRelativeTimeLabel(entry.createdAt)}
                  </time>
                  <ComposerBanner.Dismiss
                    className="z-10"
                    aria-label={t("Delete stashed prompt")}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onDelete(entry)}
                  />
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
            ))
          )}
        </ComposerBanner.Children>
      </ComposerBanner.Scroll>
    </ComposerBanner.Root>
  );
});
