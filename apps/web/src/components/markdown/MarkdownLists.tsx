import React, { use, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { type MarkdownHtmlAstNode } from "./markdownPlugins";

export function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);

  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );

  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);

  if (!match?.[1]) return null;

  return listItemStart + firstLine.indexOf(match[1]);
}

/**
 * The default `1.25rem` marker gutter (`.chat-markdown ol`) fits markers up to
 * two characters wide. Once a marker reaches three characters (item 100+),
 * `list-style-position: outside` paints it wider than that gutter and clips
 * the leading character against the item's own overflow. Rather than widening
 * the gutter for every list, only lists whose widest marker is 3+ characters
 * get a wider `--list-gutter`. The width includes a negative marker's minus
 * sign.
 */
export function orderedListGutterStyle(
  itemCount: number,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);

  if (markerWidth <= 2) return undefined;

  return { "--list-gutter": `${markerWidth + 1}ch` };
}

function isTaskListItem(node: MarkdownHtmlAstNode): boolean {
  const className = node.properties?.className;

  return Array.isArray(className) && className.includes("task-list-item");
}

function findTaskCheckbox(node: MarkdownHtmlAstNode): MarkdownHtmlAstNode | null {
  for (const child of node.children ?? []) {
    if (child.type !== "element") continue;

    if (child.tagName === "input" && child.properties?.type === "checkbox") return child;

    // Loose lists wrap the checkbox in a paragraph.
    if (child.tagName === "p") {
      const nested = findTaskCheckbox(child);

      if (nested) return nested;
    }
  }

  return null;
}

/** Done and total counts for a checklist's own items, or null below two tasks. */
export function taskListProgress(
  node: MarkdownHtmlAstNode | undefined,
): { readonly done: number; readonly total: number } | null {
  let done = 0;
  let total = 0;

  for (const child of node?.children ?? []) {
    if (child.type !== "element" || child.tagName !== "li" || !isTaskListItem(child)) continue;
    const checkbox = findTaskCheckbox(child);

    if (!checkbox) continue;
    total += 1;

    if (checkbox.properties?.checked === true) done += 1;
  }

  return total >= 2 ? { done, total } : null;
}

/** True inside a list, so nested checklists do not repeat the progress summary. */
const MarkdownListNestingContext = React.createContext(false);

function MarkdownTaskListProgress({ done, total }: { done: number; total: number }) {
  const { t } = useI18n();

  return (
    <div className="chat-markdown-task-progress" data-task-progress={`${done}/${total}`}>
      <span
        className="chat-markdown-task-progress-track"
        role="progressbar"
        aria-label={t("Checklist progress")}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <span
          className="chat-markdown-task-progress-fill"
          style={{ "--task-progress": `${Math.round((done / total) * 100)}%` }}
        />
      </span>
      <span>{t("{done} of {total} done", { done, total })}</span>
    </div>
  );
}

export function MarkdownList({
  node,
  children,
}: {
  node: MarkdownHtmlAstNode | undefined;
  children: ReactNode;
}) {
  const nested = use(MarkdownListNestingContext);
  const progress = nested ? null : taskListProgress(node);
  const list = <MarkdownListNestingContext value>{children}</MarkdownListNestingContext>;

  if (!progress) return list;

  return (
    <>
      <MarkdownTaskListProgress done={progress.done} total={progress.total} />
      {list}
    </>
  );
}
