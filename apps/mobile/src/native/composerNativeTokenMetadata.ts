import {
  BROWSER_MENTION_LABEL,
  type ComposerInlineToken,
  UNKNOWN_BOT_MENTION_LABEL,
  UNKNOWN_CHAT_MENTION_LABEL,
} from "@akeru/shared/composerInlineTokens";
import { markdownFileIconSource } from "@akeru/mobile-markdown-text/file-icons";
import { resolveMarkdownFileIcon } from "@akeru/mobile-markdown-text/links";
import { Image } from "react-native";

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

  return separator >= 0 ? path.slice(separator + 1) : path;
}

/** The chip label the native editor draws for an inline token. */
export function composerTokenLabel(
  token: ComposerInlineToken,
  skillLabels: ReadonlyMap<string, string>,
  threadTitles: ReadonlyMap<string, string>,
  botNames: ReadonlyMap<string, string>,
): string {
  switch (token.type) {
    case "skill":
      return skillLabels.get(token.value) ?? token.value;
    case "browser-mention":
      return BROWSER_MENTION_LABEL;
    case "thread-mention":
      return threadTitles.get(token.value) ?? UNKNOWN_CHAT_MENTION_LABEL;
    case "bot-mention":
      return botNames.get(token.value) ?? UNKNOWN_BOT_MENTION_LABEL;
    default:
      return basename(token.value);
  }
}

/** Resolved asset URI of the file-type icon for a file mention chip. */
export function composerFileIconUri(path: string): string {
  return Image.resolveAssetSource(markdownFileIconSource(resolveMarkdownFileIcon(path))).uri;
}
