import type { McpServer } from "@akeru/contracts";
import { createTranslator } from "@akeru/client-runtime/i18n";

const englishTranslator = createTranslator("en");

type Translate = typeof englishTranslator.translate;

export interface McpServerDraft {
  readonly name: string;
  readonly transport: "stdio" | "url";
  readonly command: string;
  readonly args: string;
  readonly url: string;
}

export const EMPTY_MCP_SERVER_DRAFT: McpServerDraft = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
};

export function draftFromServer(server: McpServer): McpServerDraft {
  return server.transport === "stdio"
    ? {
        name: server.name,
        transport: "stdio",
        command: server.command,
        args: server.args?.join("\n") ?? "",
        url: "",
      }
    : {
        name: server.name,
        transport: "url",
        command: "",
        args: "",
        url: server.url,
      };
}

export function validateMcpServerDraft(
  draft: McpServerDraft,
  t: Translate = englishTranslator.translate,
): string | null {
  if (!draft.name.trim()) return t("Name is required.");
  if (draft.transport === "stdio") {
    return draft.command.trim() ? null : t("Command is required.");
  }
  try {
    const url = new URL(draft.url.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return t("URL must start with http:// or https://.");
    }
    return url.username || url.password ? t("Store credentials outside the server URL.") : null;
  } catch {
    return t("Enter a valid HTTP or HTTPS URL.");
  }
}
