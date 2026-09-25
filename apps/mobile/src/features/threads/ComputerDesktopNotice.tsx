import { useAtomValue } from "@effect/atom-react";
import type { BotId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";
import { useThemeColor } from "../../lib/useThemeColor";
import { environmentBotsAtom } from "../../state/bots";
import { computerEnvironment } from "../../state/computer";
import { useEnvironmentQuery } from "../../state/query";

/**
 * Mobile does not stream or control a bot's computer. When one is running it
 * says so and points to the desktop and web clients, which own the viewer.
 */
export function ComputerDesktopNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly botId: BotId | null;
}) {
  const { t } = useMobileI18n();
  const iconColor = useThemeColor("--color-icon-subtle");
  const bots = useAtomValue(environmentBotsAtom(props.environmentId));
  const bot = props.botId === null ? null : bots.find((entry) => entry.id === props.botId);
  const state = useEnvironmentQuery(
    bot
      ? computerEnvironment.state({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  ).data;
  if (!bot || (state?.status !== "ready" && state?.status !== "human")) return null;

  return (
    <View className="mx-4 mb-2 flex-row items-start gap-2 rounded-xl border border-border-subtle bg-card px-3 py-2">
      <SymbolView name="desktopcomputer" size={14} tintColor={iconColor} type="monochrome" />
      <View className="flex-1">
        <Text className="text-sm font-t3-medium text-foreground">
          {t("{name}'s computer is running", { name: bot.name })}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {t("Open Akeru Bot on a desktop or in a web browser to watch or take control of it.")}
        </Text>
      </View>
    </View>
  );
}
