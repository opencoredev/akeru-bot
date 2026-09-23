import { type KeyboardEvent, type Ref, useImperativeHandle, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { useI18n } from "../../i18n";
import { ComposerCommandMenu, type ComposerCommandItem } from "../chat/ComposerCommandMenu";
import { resolveComposerMenuActiveItemId } from "../chat/composerMenuHighlight";
import {
  buildComposerProviderMenuItems,
  composerProviderMenuItemText,
  type ComposerProviderCatalog,
} from "../chat/composerProviderMenuItems";
import type { BotPromptCommandTrigger } from "./botPromptCommands.logic";

export interface BotPromptCommandMenuHandle {
  /** Handles picker keys. Returns true when the key was consumed. */
  readonly handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * The `$` skill and `/` command picker, the same menu the classic composer shows.
 * Mounted only while a trigger is being typed, so settings stay off the typing path.
 * `onSelect` receives the text that replaces the typed token.
 */
export function BotPromptCommandMenu({
  ref,
  trigger,
  catalog,
  onSelect,
  onClose,
}: {
  ref: Ref<BotPromptCommandMenuHandle>;
  trigger: BotPromptCommandTrigger;
  catalog: ComposerProviderCatalog;
  onSelect: (inserted: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const showSkillsInSlashMenu = usePrimarySettings((settings) => settings.showSkillsInSlashMenu);
  const { resolvedTheme } = useTheme();
  const { kind, query } = trigger;
  const items = useMemo(
    () =>
      buildComposerProviderMenuItems({
        trigger: { kind, query },
        catalog,
        showSkillsInSlashMenu,
        t,
      }),
    [catalog, kind, query, showSkillsInSlashMenu, t],
  );
  const searchKey = `${trigger.kind}:${trigger.query.trim().toLowerCase()}`;
  const [highlight, setHighlight] = useState<{ itemId: string | null; searchKey: string | null }>(
    { itemId: null, searchKey: null },
  );
  const activeItemId = resolveComposerMenuActiveItemId({
    items,
    highlightedItemId: highlight.itemId,
    currentSearchKey: searchKey,
    highlightedSearchKey: highlight.searchKey,
  });
  const select = (item: ComposerCommandItem) => {
    if (item.type === "skill" || item.type === "provider-slash-command") {
      onSelect(composerProviderMenuItemText(item));
    }
  };

  useImperativeHandle(ref, () => ({
    handleKeyDown: (event) => {
      if (event.nativeEvent.isComposing) return false;
      if (event.key === "Escape") {
        onClose();
        return true;
      }
      if (items.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const index = items.findIndex((item) => item.id === activeItemId);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = items[(index + step + items.length) % items.length];
        setHighlight({ itemId: next?.id ?? null, searchKey });
        return true;
      }
      if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey)) {
        const item = items.find((candidate) => candidate.id === activeItemId) ?? items[0];
        if (item) select(item);
        return true;
      }
      return false;
    },
  }));

  return (
    <div
      data-testid="bot-prompt-command-menu"
      // Tucks the drawer's masked bottom edge behind the prompt box, like the classic composer.
      className="absolute inset-x-5 bottom-full z-0 -mb-4"
    >
      <ComposerCommandMenu
        items={items}
        resolvedTheme={resolvedTheme}
        isLoading={false}
        triggerKind={trigger.kind}
        emptyStateText={
          trigger.kind === "skill"
            ? t("No skills found. Try / to browse provider commands.")
            : t("No matching command.")
        }
        activeItemId={activeItemId}
        onHighlightedItemChange={(itemId) => setHighlight({ itemId, searchKey })}
        onSelect={select}
      />
    </div>
  );
}
