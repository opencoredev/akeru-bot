import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_TOOL_CATALOG,
  type RuntimeMode,
} from "@akeru/contracts";
import {
  AKERU_LIST_ROUTINES_TOOL_NAME,
  AKERU_DELETE_ROUTINES_TOOL_NAME,
} from "./AkeruRoutineSchemas.ts";

export type AkeruToolCategory = "read" | "edit" | "execute" | "mcp" | "other";

export function akeruToolCategory(toolName: string): AkeruToolCategory {
  if (/read|view|grep|search|find|list|stat/i.test(toolName)) return "read";

  // Akeru's own tools change accounts and bots, not files, so Auto-accept edits never covers
  // them, even when a name such as RemoveMcpAccount contains an edit word.
  if (/edit|write|delete|mkdir|move|rename/i.test(toolName)) {
    return AKERU_TOOL_CATALOG.some((tool) => tool.id === toolName) ? "execute" : "edit";
  }

  if (/execute|command|shell|process|terminal/i.test(toolName)) return "execute";

  if (/mcp/i.test(toolName)) return "mcp";

  return "other";
}

/** Whether the chat's permission mode lets a tool in this category run without asking. */
export function permissionPolicy(
  runtimeMode: RuntimeMode,
  category: AkeruToolCategory,
): "allow" | "ask" {
  if (runtimeMode === "full-access" || runtimeMode === "auto") return "allow";

  if (category === "read") return "allow";

  if (runtimeMode === "auto-accept-edits" && category === "edit") return "allow";

  return "ask";
}

export function routineToolNeedsGlobalApproval(toolName: string): boolean {
  return (
    toolName !== AKERU_CREATE_ROUTINE_TOOL_NAME &&
    toolName !== AKERU_LIST_ROUTINES_TOOL_NAME &&
    toolName !== AKERU_DELETE_ROUTINES_TOOL_NAME
  );
}
