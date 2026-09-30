import type { AkeruMemoryDocumentTarget } from "@t3tools/contracts";

/** User-facing names for the bot memory documents, shared by the editor and backup preview. */
export const memoryDocumentCopy: Record<
  AkeruMemoryDocumentTarget,
  { readonly title: string; readonly fileName: string; readonly description: string }
> = {
  user: {
    title: "About you",
    fileName: "USER.md",
    description: "Lasting details this bot has learned about you. It reads them in every chat.",
  },
  memory: {
    title: "Bot notes",
    fileName: "MEMORY.md",
    description: "Notes and working habits this bot keeps for itself across chats.",
  },
  group: {
    title: "Group notes",
    fileName: "GROUP.md",
    description: "Private notes this bot keeps about the current group chat.",
  },
};
