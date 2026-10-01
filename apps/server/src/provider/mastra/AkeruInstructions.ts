// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { RequestContext } from "@mastra/core/request-context";
import * as DateTime from "effect/DateTime";
import { createAkeruAgentInstructions, createAkeruBotInstructions } from "../AkeruAgentInstructions.ts";
import { controllerContext } from "./AkeruMemory.ts";

export function resolveAkeruInstructions(
  requestContext: RequestContext,
  now = DateTime.nowUnsafe(),
): string {
  const state = controllerContext(requestContext)?.state;
  const isBotConversation =
    typeof state === "object" &&
    state !== null &&
    "botConversation" in state &&
    state.botConversation === true;
  const name =
    isBotConversation && "botName" in state && typeof state.botName === "string"
      ? state.botName
      : "Akeru";
  const personalityTone =
    isBotConversation && "personalityTone" in state && typeof state.personalityTone === "number"
      ? state.personalityTone
      : undefined;
  const instructions = isBotConversation
    ? createAkeruBotInstructions({
        name,
        now,
        ...(personalityTone !== undefined ? { personalityTone } : {}),
      })
    : createAkeruAgentInstructions({
        name,
        now,
        ...(personalityTone !== undefined ? { personalityTone } : {}),
      });
  const persistentMemoryContext =
    typeof state === "object" &&
    state !== null &&
    "persistentMemoryContext" in state &&
    typeof state.persistentMemoryContext === "string"
      ? state.persistentMemoryContext
      : "";
  const mcpInstructions =
    typeof state === "object" &&
    state !== null &&
    "mcpInstructions" in state &&
    typeof state.mcpInstructions === "string"
      ? state.mcpInstructions
      : "";
  return [instructions, mcpInstructions, persistentMemoryContext].filter(Boolean).join("\n\n");
}
