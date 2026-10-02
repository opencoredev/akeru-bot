import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import type { SelectableMarkdownSkill } from "./SelectableMarkdownText.types";
import { resolveMarkdownLinkPresentation, type MarkdownFileIcon } from "./markdownLinks";
import type { NativeMarkdownTextRun } from "./nativeMarkdownTextTypes";

export interface RunContext {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strikethrough: boolean;
  readonly code: boolean;
  readonly href?: string;
  readonly externalHost?: string;
  readonly fileIcon?: MarkdownFileIcon;
  readonly role?: NativeMarkdownTextRun["role"];
  readonly headingLevel?: number;
  readonly depth?: number;
  readonly spacing?: number;
  readonly firstLineHeadIndent?: number;
  readonly headIndent?: number;
  readonly paragraphSpacing?: number;
}

export const EMPTY_CONTEXT: RunContext = {
  bold: false,
  italic: false,
  strikethrough: false,
  code: false,
};

const INLINE_HTML_TAG_PATTERN = /<\/?(?:kbd|mark|sub|sup|u)(?:\s[^>]*)?>/gi;

function decodeCodePoint(codePoint: number, entity: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }

  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntitiesOnce(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) {
        return decodeCodePoint(Number.parseInt(decimal, 10), entity);
      }

      if (hexadecimal) {
        return decodeCodePoint(Number.parseInt(hexadecimal, 16), entity);
      }

      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&apos;":
          return "'";
        case "&gt;":
          return ">";
        case "&lt;":
          return "<";
        case "&nbsp;":
          return "\u00a0";
        case "&quot;":
          return '"';
        default:
          return entity;
      }
    },
  );
}

function decodeHtmlEntities(value: string): string {
  let decoded = value;

  for (let pass = 0; pass < 2; pass += 1) {
    const next = decodeHtmlEntitiesOnce(decoded);

    if (next === decoded) {
      break;
    }

    decoded = next;
  }

  return decoded;
}

function textNodeContent(value: string): string {
  return decodeHtmlEntities(value).replace(INLINE_HTML_TAG_PATTERN, "");
}

export function inlineHtmlText(value: string): string {
  if (/^<br\s*\/?>$/i.test(value.trim())) {
    return "\n";
  }

  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ""));
}

function sameRunStyle(left: NativeMarkdownTextRun, right: NativeMarkdownTextRun): boolean {
  return (
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.strikethrough === right.strikethrough &&
    left.code === right.code &&
    left.href === right.href &&
    left.externalHost === right.externalHost &&
    left.fileIcon === right.fileIcon &&
    left.skillName === right.skillName &&
    left.skillLabel === right.skillLabel &&
    left.skillIcon === right.skillIcon &&
    left.role === right.role &&
    left.headingLevel === right.headingLevel &&
    left.depth === right.depth &&
    left.spacing === right.spacing &&
    left.firstLineHeadIndent === right.firstLineHeadIndent &&
    left.headIndent === right.headIndent &&
    left.paragraphSpacing === right.paragraphSpacing
  );
}

export function appendRun(
  runs: NativeMarkdownTextRun[],
  text: string,
  context: RunContext,
): NativeMarkdownTextRun[] {
  if (text.length === 0) {
    return runs;
  }

  const run: NativeMarkdownTextRun = {
    text,
    ...(context.bold ? { bold: true } : {}),
    ...(context.italic ? { italic: true } : {}),
    ...(context.strikethrough ? { strikethrough: true } : {}),
    ...(context.code ? { code: true } : {}),
    ...(context.href ? { href: context.href } : {}),
    ...(context.externalHost ? { externalHost: context.externalHost } : {}),
    ...(context.fileIcon ? { fileIcon: context.fileIcon } : {}),
    ...(context.role ? { role: context.role } : {}),
    ...(context.headingLevel ? { headingLevel: context.headingLevel } : {}),
    ...(context.depth ? { depth: context.depth } : {}),
    ...(context.spacing ? { spacing: context.spacing } : {}),
    ...(context.firstLineHeadIndent !== undefined
      ? { firstLineHeadIndent: context.firstLineHeadIndent }
      : {}),
    ...(context.headIndent !== undefined ? { headIndent: context.headIndent } : {}),
    ...(context.paragraphSpacing !== undefined
      ? { paragraphSpacing: context.paragraphSpacing }
      : {}),
  };

  const previous = runs.at(-1);

  if (previous && sameRunStyle(previous, run)) {
    runs[runs.length - 1] = { ...previous, text: previous.text + run.text };

    return runs;
  }

  runs.push(run);

  return runs;
}

function formatSkillLabel(skill: SelectableMarkdownSkill): string {
  const displayName = skill.displayName?.trim();

  if (displayName) {
    return displayName;
  }

  return skill.name
    .split(/[\s:_-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function decorateSkillRuns(
  runs: ReadonlyArray<NativeMarkdownTextRun>,
  skills: ReadonlyArray<SelectableMarkdownSkill>,
): ReadonlyArray<NativeMarkdownTextRun> {
  if (skills.length === 0) {
    return runs;
  }

  const skillByToken = new Map(skills.map((skill) => [skill.token ?? `$${skill.name}`, skill]));
  const literalTokens = skills.flatMap((skill) => (skill.token ? [escapeRegExp(skill.token)] : []));

  const tokenRegex = new RegExp(
    `(^|\\s)(\\$[a-zA-Z][a-zA-Z0-9:_-]*${literalTokens.map((token) => `|${token}`).join("")})(?=\\s|$)`,
    "g",
  );

  const decorated: NativeMarkdownTextRun[] = [];

  for (const run of runs) {
    if (run.code || run.href || run.fileIcon || run.role === "code-block") {
      decorated.push(run);
      continue;
    }

    let cursor = 0;
    let matched = false;

    for (const match of run.text.matchAll(tokenRegex)) {
      const prefix = match[1] ?? "";
      const token = match[2] ?? "";
      const skill = skillByToken.get(token);

      if (!skill) {
        continue;
      }

      const start = (match.index ?? 0) + prefix.length;
      const end = start + token.length;

      if (start > cursor) {
        decorated.push({ ...run, text: run.text.slice(cursor, start) });
      }

      decorated.push({
        ...run,
        text: run.text.slice(start, end),
        skillName: skill.name,
        skillLabel: formatSkillLabel(skill),
        ...(skill.icon ? { skillIcon: skill.icon } : {}),
      });
      cursor = end;
      matched = true;
    }

    if (!matched) {
      decorated.push(run);
    } else if (cursor < run.text.length) {
      decorated.push({ ...run, text: run.text.slice(cursor) });
    }
  }

  return decorated;
}

function appendChildren(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  context: RunContext,
): NativeMarkdownTextRun[] {
  for (const child of node.children ?? []) {
    appendNode(runs, child, context);
  }

  return runs;
}

export function nodeTextContent(node: MarkdownNode): string {
  if (node.content !== undefined) {
    return node.content;
  }

  return (node.children ?? []).map(nodeTextContent).join("");
}

export function appendNode(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  context: RunContext,
): NativeMarkdownTextRun[] {
  switch (node.type) {
    case "text":
    case "math_inline":
      return appendRun(runs, textNodeContent(nodeTextContent(node)), context);
    case "html_inline":
      return appendRun(runs, inlineHtmlText(nodeTextContent(node)), context);
    case "code_inline":
      return appendRun(runs, nodeTextContent(node), { ...context, code: true });
    case "soft_break":
      return appendRun(runs, " ", context);
    case "line_break":
      return appendRun(runs, "\n", context);
    case "bold":
      return appendChildren(runs, node, { ...context, bold: true });
    case "italic":
      return appendChildren(runs, node, { ...context, italic: true });
    case "strikethrough":
      return appendChildren(runs, node, { ...context, strikethrough: true });
    case "link": {
      const presentation = resolveMarkdownLinkPresentation(node.href ?? "");

      if (presentation.kind === "file") {
        return appendRun(runs, presentation.label, {
          ...context,
          href: presentation.href,
          fileIcon: presentation.icon,
        });
      }

      if (presentation.kind === "external") {
        return appendChildren(runs, node, {
          ...context,
          href: presentation.href,
          externalHost: presentation.host,
        });
      }

      return appendChildren(runs, node, {
        ...context,
        ...(presentation.href ? { href: presentation.href } : {}),
      });
    }

    case "image":
      return appendRun(runs, node.alt ?? node.title ?? "", context);
    default:
      return appendChildren(runs, node, context);
  }
}

export function nativeMarkdownTextRuns(node: MarkdownNode): ReadonlyArray<NativeMarkdownTextRun> {
  return appendChildren([], node, EMPTY_CONTEXT);
}

export function nativeMarkdownWithPreservedSoftBreaks(node: MarkdownNode): MarkdownNode {
  const children = node.children?.map(nativeMarkdownWithPreservedSoftBreaks);

  return {
    ...node,
    ...(node.type === "soft_break" ? { type: "line_break" as const } : {}),
    ...(children ? { children } : {}),
  };
}
