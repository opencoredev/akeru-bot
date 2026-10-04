import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import type { MarkdownFileIcon } from "./markdownLinks";

export interface NativeMarkdownTextRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
  readonly code?: boolean;
  readonly href?: string;
  readonly externalHost?: string;
  readonly fileIcon?: MarkdownFileIcon;
  readonly skillName?: string;
  readonly skillLabel?: string;
  readonly skillIcon?: string;
  readonly role?:
    | "body"
    | "heading"
    | "list-marker"
    | "list-break"
    | "quote-marker"
    | "code-block"
    | "code-language"
    | "divider"
    | "spacer";
  readonly headingLevel?: number;
  readonly depth?: number;
  readonly spacing?: number;
  readonly firstLineHeadIndent?: number;
  readonly headIndent?: number;
  readonly paragraphSpacing?: number;
}

export type NativeMarkdownDocumentChunk =
  | {
      readonly kind: "selectable";
      readonly key: string;
      readonly node: MarkdownNode;
    }
  | {
      readonly kind: "rich";
      readonly key: string;
      readonly node: MarkdownNode;
    };
