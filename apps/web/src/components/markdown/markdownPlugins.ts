import type { Options as ReactMarkdownOptions } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkGithubAlerts } from "../../markdown-github-alerts";
import { remarkNormalizeListItemIndentation } from "../../markdown-list-indentation";
import { WINDOWS_DRIVE_PATH_REGEX } from "./markdownPaths";

export type MarkdownHtmlAstNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownHtmlAstNode[];
};

/** Preserve Windows drive paths through the protocol allowlist in rehype-sanitize. */
function rehypeNormalizeWindowsImageSrc() {
  return (tree: MarkdownHtmlAstNode) => {
    const visit = (node: MarkdownHtmlAstNode) => {
      const src = node.properties?.src;

      if (
        node.type === "element" &&
        node.tagName === "img" &&
        typeof src === "string" &&
        WINDOWS_DRIVE_PATH_REGEX.test(src)
      ) {
        node.properties = {
          ...node.properties,
          src: `file:///${src.replaceAll("\\", "/")}`,
        };
      }

      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta", "dataInlineCode"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", "grokbot"],
    src: [...(defaultSchema.protocols?.src ?? []), "file"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

export const CHAT_MARKDOWN_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [
  remarkGfm,
  remarkMath,
  remarkTagMathNodes,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

export const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS: NonNullable<
  ReactMarkdownOptions["remarkPlugins"]
> = [
  remarkGfm,
  remarkMath,
  remarkTagMathNodes,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkNormalizeLinksAndTagInlineCode,
];

export const CHAT_MARKDOWN_REHYPE_PLUGINS_WITH_RAW_HTML: NonNullable<
  ReactMarkdownOptions["rehypePlugins"]
> = [rehypeRaw, rehypeNormalizeWindowsImageSrc, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]];

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  url?: string;
  value?: string;
  lang?: string;
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

function remarkTagMathNodes() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "inlineMath" && typeof node.value === "string") {
        node.type = "inlineCode";
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataMathExpression: node.value,
          },
        };
      } else if (node.type === "math" && typeof node.value === "string") {
        node.type = "code";
        node.lang = "math";
      }

      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }

      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

/**
 * Preserve Windows drive links as allowed `file:` URLs before sanitization.
 * The same traversal tags inline code while it can still be distinguished
 * from fenced code. Code inside links stays untagged to avoid nested anchors.
 */
function remarkNormalizeLinksAndTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (
        (node.type === "link" || node.type === "definition") &&
        typeof node.url === "string" &&
        WINDOWS_DRIVE_PATH_REGEX.test(node.url)
      ) {
        node.url = `file:///${node.url.replaceAll("\\", "/")}`;
      }

      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataInlineCode: "",
          },
        };
      }

      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };

    visit(tree, false);
  };
}
