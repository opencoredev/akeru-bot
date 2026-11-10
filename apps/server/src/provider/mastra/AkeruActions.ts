import { AKERU_CREATE_ROUTINE_TOOL_NAME } from "@akeru/contracts";
import {
  AKERU_LIST_ROUTINES_TOOL_NAME,
  AKERU_DELETE_ROUTINES_TOOL_NAME,
} from "./AkeruRoutineSchemas.ts";

export type AkeruToolCategory = "read" | "edit" | "execute" | "mcp" | "other";

export function akeruToolCategory(toolName: string): AkeruToolCategory {
  if (/read|view|grep|search|find|list|stat/i.test(toolName)) return "read";

  if (/edit|write|delete|mkdir|move|rename/i.test(toolName)) return "edit";

  if (/execute|command|shell|process|terminal/i.test(toolName)) return "execute";

  if (/mcp/i.test(toolName)) return "mcp";

  return "other";
}

export function routineToolNeedsGlobalApproval(toolName: string): boolean {
  return (
    toolName !== AKERU_CREATE_ROUTINE_TOOL_NAME &&
    toolName !== AKERU_LIST_ROUTINES_TOOL_NAME &&
    toolName !== AKERU_DELETE_ROUTINES_TOOL_NAME
  );
}
