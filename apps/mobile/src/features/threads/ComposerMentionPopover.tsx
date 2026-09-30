import type { EnvironmentId, ServerProvider } from "@akeru/contracts";
import { useAtomValue } from "@effect/atom-react";
import { memo, useMemo } from "react";
import { View } from "react-native";

import { environmentBotsAtom, environmentGroupsAtom } from "../../state/bots";
import { useThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { ComposerCommandPopover, type ComposerCommandItem } from "./ComposerCommandPopover";
import {
  buildComposerMentionItems,
  groupMentionBots,
  isThreadMentionQuery,
  threadMentionQuery,
} from "./composerMentionItems";

/**
 * The `@` menu: browser, bot, and chat mentions ahead of file results. Mounted only
 * while an `@` token is being typed, so thread shell updates do not re-render
 * the composer. The draft keeps only the token; the server expands it.
 */
export const ComposerMentionPopover = memo(function ComposerMentionPopover(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly projectId: string;
  /** The group of a group chat, whose bots can be mentioned; null for a direct chat. */
  readonly groupId: string | null;
  readonly browserAvailable: boolean;
  /** The environment's providers, used to mark bots that cannot take handed-off work. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly query: string;
  readonly fileItems: ReadonlyArray<ComposerCommandItem>;
  readonly isLoading: boolean;
  readonly onSelect: (item: ComposerCommandItem) => void;
}) {
  const shells = useThreadShells();
  const environmentBots = useAtomValue(environmentBotsAtom(props.environmentId));
  const groups = useAtomValue(environmentGroupsAtom(props.environmentId));
  const bots = useMemo(
    () =>
      groupMentionBots(
        groups.find((group) => group.id === props.groupId),
        environmentBots,
        props.providers,
      ),
    [environmentBots, groups, props.groupId, props.providers],
  );
  const environmentIds = useMemo(() => [props.environmentId], [props.environmentId]);
  const search = useThreadSearch(environmentIds, threadMentionQuery(props.query));
  const items = useMemo(() => {
    const matchedIds = new Set<string>();
    for (const match of search.matches) {
      if (match.environmentId === props.environmentId) matchedIds.add(match.threadId);
    }
    const mentions = buildComposerMentionItems({
      query: props.query,
      browserAvailable: props.browserAvailable,
      bots,
      threads: shells.filter((shell) => shell.environmentId === props.environmentId),
      currentThreadId: props.threadId,
      currentProjectId: props.projectId,
      matchedIds,
    });
    // `@chat:` skips file search, so file results from an earlier query are stale.
    return isThreadMentionQuery(props.query) ? mentions : [...mentions, ...props.fileItems];
  }, [
    bots,
    props.browserAvailable,
    props.environmentId,
    props.fileItems,
    props.projectId,
    props.query,
    props.threadId,
    search.matches,
    shells,
  ]);

  if (items.length === 0) return null;
  return (
    <View className="absolute inset-x-0 bottom-full z-10 mb-2">
      <ComposerCommandPopover
        items={items}
        triggerKind="path"
        isLoading={props.isLoading}
        onSelect={props.onSelect}
      />
    </View>
  );
});
