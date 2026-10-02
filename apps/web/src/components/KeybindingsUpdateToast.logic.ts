import { Data } from "effect";
import type { ServerConfigStreamEvent } from "@akeru/contracts";

export const KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS = 2_000;

export type KeybindingsUpdateToastDecision =
  | { readonly _tag: "Success" }
  | { readonly _tag: "InvalidConfiguration"; readonly message: string };

const ToastDecision = Data.taggedEnum<KeybindingsUpdateToastDecision>();

export interface KeybindingsUpdateToastController {
  readonly handle: (event: ServerConfigStreamEvent | null) => KeybindingsUpdateToastDecision | null;
}

export function createKeybindingsUpdateToastController(input: {
  readonly now?: () => number;
}): KeybindingsUpdateToastController {
  const now = input.now ?? Date.now;
  let lastSuccessToastAt: number | null = null;

  return {
    handle: (event) => {
      if (event?.type !== "keybindingsUpdated") {
        return null;
      }

      const issue = event.payload.issues.find((entry) => entry.kind.startsWith("keybindings."));

      if (issue) {
        return ToastDecision.InvalidConfiguration({ message: issue.message });
      }

      const currentTime = now();

      if (
        lastSuccessToastAt !== null &&
        currentTime - lastSuccessToastAt < KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS
      ) {
        return null;
      }

      lastSuccessToastAt = currentTime;

      return ToastDecision.Success();
    },
  };
}
