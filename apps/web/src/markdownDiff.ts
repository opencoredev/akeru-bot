/**
 * Line classification for ```diff and ```patch fences in chat. Pure and
 * line-local so a streaming prefix classifies every complete line exactly as
 * the settled message will, and a reload re-renders identical markup.
 */
export type MarkdownDiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

export interface MarkdownDiffLine {
  readonly kind: MarkdownDiffLineKind;
  readonly text: string;
}

export interface ParsedMarkdownDiff {
  readonly lines: ReadonlyArray<MarkdownDiffLine>;
  readonly additions: number;
  readonly deletions: number;
  /** Changed file paths in order, from `+++`/`---` headers or `diff --git` lines. */
  readonly files: ReadonlyArray<string>;
}

export const MARKDOWN_DIFF_LANGUAGES: ReadonlySet<string> = new Set(["diff", "patch"]);

const META_LINE_PATTERN =
  /^(?:diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |\\ )/;
const GIT_DIFF_HEADER_PATTERN = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RANGE_PATTERN = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

function headerPath(line: string): string | null {
  const raw = line.slice(4).split("\t")[0]?.trim() ?? "";
  if (raw === "" || raw === "/dev/null") return null;
  return raw.replace(/^[ab]\//, "");
}

export function parseMarkdownDiff(code: string): ParsedMarkdownDiff {
  // Fenced code always ends with one newline; it is not an extra blank line.
  const rawLines = (code.endsWith("\n") ? code.slice(0, -1) : code).split("\n");
  const lines: MarkdownDiffLine[] = [];
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  // Lines still owed to the current hunk by its `@@` ranges, or null when the
  // header has no ranges and the hunk runs until the next `diff --git`.
  let hunkRemaining: { old: number; new: number } | null = null;
  let pendingGitPath: string | null = null;

  const pushFile = (path: string | null) => {
    if (path !== null && files.at(-1) !== path) files.push(path);
  };

  // Ends the hunk once its ranges are used up, so a following `---`/`+++`
  // pair reads as the next file's header.
  const consumeHunkLine = (oldLines: number, newLines: number) => {
    if (!inHunk || hunkRemaining === null) return;
    hunkRemaining.old -= oldLines;
    hunkRemaining.new -= newLines;
    if (hunkRemaining.old <= 0 && hunkRemaining.new <= 0) inHunk = false;
  };

  for (let index = 0; index < rawLines.length; index += 1) {
    const text = rawLines[index] ?? "";
    const next = rawLines[index + 1];

    if (text.startsWith("@@")) {
      inHunk = true;
      const range = HUNK_RANGE_PATTERN.exec(text);
      hunkRemaining = range ? { old: Number(range[1] ?? "1"), new: Number(range[2] ?? "1") } : null;
      if (pendingGitPath !== null) {
        pushFile(pendingGitPath);
        pendingGitPath = null;
      }
      lines.push({ kind: "hunk", text });
      continue;
    }
    if (META_LINE_PATTERN.test(text)) {
      const gitHeader = GIT_DIFF_HEADER_PATTERN.exec(text);
      if (gitHeader) {
        inHunk = false;
        if (pendingGitPath !== null) pushFile(pendingGitPath);
        pendingGitPath = gitHeader[2] ?? null;
      }
      lines.push({ kind: "meta", text });
      continue;
    }
    // Outside a hunk, a `---` line is a file header when `+++` follows or when
    // it ends the text (a header whose `+++` has not streamed in yet). Inside a
    // hunk, `---` and `+++` are an ordinary removal and addition.
    if (!inHunk && text.startsWith("--- ") && (next === undefined || next.startsWith("+++ "))) {
      lines.push({ kind: "meta", text });
      if (next !== undefined) {
        pendingGitPath = null;
        pushFile(headerPath(next) ?? headerPath(text));
        lines.push({ kind: "meta", text: next });
        index += 1;
      }
      continue;
    }
    if (!inHunk && text.startsWith("+++ ")) {
      lines.push({ kind: "meta", text });
      continue;
    }
    if (text.startsWith("+")) {
      additions += 1;
      lines.push({ kind: "add", text });
      consumeHunkLine(0, 1);
      continue;
    }
    if (text.startsWith("-")) {
      deletions += 1;
      lines.push({ kind: "remove", text });
      consumeHunkLine(1, 0);
      continue;
    }
    lines.push({ kind: "context", text });
    consumeHunkLine(1, 1);
  }
  if (pendingGitPath !== null) pushFile(pendingGitPath);

  return { lines, additions, deletions, files };
}
