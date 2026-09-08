import { useAtomValue } from "@effect/atom-react";
import { channelBindingPresentation } from "@t3tools/client-runtime/channel-presentation";
import type { BotId, EnvironmentId } from "@t3tools/contracts";
import { Text, View } from "react-native";

import { environmentSnapshotAtom } from "../../state/shell";

export function ThreadChannels(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId | null;
}) {
  const snapshot = useAtomValue(environmentSnapshotAtom(props.environmentId));
  const bot = snapshot?.bots.find((candidate) => candidate.id === props.botId);
  if (!bot?.channelBindings.length) return null;

  return (
    <View className="mb-3 gap-2" accessibilityLabel="Channels">
      <Text className="font-t3-medium text-sm text-neutral-900 dark:text-neutral-100">
        Channels
      </Text>
      {bot.channelBindings.map((binding, index) => {
        const channel = channelBindingPresentation(binding, snapshot?.projects ?? []);
        return (
          <View key={binding.connectionId ?? `${binding.provider}:${index}`} className="gap-1">
            <Text className="font-t3-medium text-xs text-neutral-900 dark:text-neutral-100">
              {channel.provider} · {channel.health}
            </Text>
            {channel.warning ? (
              <Text className="text-xs text-amber-700 dark:text-amber-400">{channel.warning}</Text>
            ) : null}
            <Text className="text-xs text-neutral-600 dark:text-neutral-300">
              Project · {channel.project}
            </Text>
            <Text className="text-xs text-neutral-600 dark:text-neutral-300">
              Recent delivery · {channel.delivery}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
