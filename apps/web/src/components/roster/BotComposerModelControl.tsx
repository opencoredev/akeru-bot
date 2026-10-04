import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { registerComposerModelPicker } from "../../composerModelPickerRegistry";
import { resolveShortcutCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";

/**
 * Renders nothing. The model belongs to the bot, so the chat shows no picker.
 * The model shortcut and the command palette's "Change model" open the bot's
 * settings at the Model section instead.
 */
export function BotComposerModelControl({
  botId,
  disabled = false,
}: {
  readonly botId: string;
  readonly disabled?: boolean;
}) {
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  useEffect(() => {
    if (disabled) return;

    const openModelSettings = () =>
      void navigate({ to: "/bots/$botId/settings", params: { botId }, hash: "model" });

    const unregister = registerComposerModelPicker({ openModelPicker: openModelSettings });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: { modelPickerOpen: false },
      });

      if (command !== "modelPicker.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      openModelSettings();
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      unregister();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [botId, disabled, keybindings, navigate]);

  return null;
}
