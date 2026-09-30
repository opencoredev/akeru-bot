import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/**
 * Whether a bot's desktop details panel is open. The panel toggles it; the chat
 * header reads it to keep its actions clear of the floating open toggle.
 */
export function useBotDetailsOpen(botId: string) {
  return useLocalStorage(`akeru:bot-details-open:${botId}`, false, Schema.Boolean);
}

/** One preference for every group: closed until opened, and it stays how you left it. */
export function useGroupDetailsOpen() {
  return useLocalStorage("akeru:group-details-open", false, Schema.Boolean);
}
