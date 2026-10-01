import type { TurnId } from "@akeru/contracts";
import { formatDuration } from "@akeru/shared/orchestrationTiming";
import { Pressable, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useMobileI18n } from "../../lib/i18n";
import type { ThreadFeedEntry } from "../../lib/threadActivityTypes";

export function ThreadTurnFoldRow(props: {
  readonly entry: Extract<ThreadFeedEntry, { readonly type: "turn-fold" }>;
  readonly onToggle: (turnId: TurnId) => void;
  readonly iconColor: ColorValue | undefined;
}) {
  const { t } = useMobileI18n();
  const { entry } = props;

  const duration =
    entry.elapsedMs === null
      ? null
      : formatDuration(entry.elapsedMs).replace(
          /(\d+(?:\.\d+)?)(ms|s|m|h)/g,
          (_, count: string, unit: string) => {
            switch (unit) {
              case "ms":
                return t("{count}ms", { count });
              case "s":
                return t("{count}s", { count });
              case "m":
                return t("{count}m", { count });
              default:
                return t("{count}h", { count });
            }
          },
        );

  const label = entry.interrupted
    ? duration === null
      ? t("You stopped this response")
      : t("You stopped after {duration}", { duration })
    : duration === null
      ? t("Worked")
      : t("Worked for {duration}", { duration });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: entry.expanded }}
      onPress={() => props.onToggle(entry.turnId)}
      hitSlop={4}
      className="mb-3 min-h-11 flex-row items-center gap-2 border-b border-border-subtle px-2"
    >
      <Text className="font-t3-medium text-sm tabular-nums text-foreground-muted">{label}</Text>
      <SymbolView
        name={entry.expanded ? "chevron.down" : "chevron.right"}
        size={15}
        tintColor={props.iconColor}
        type="monochrome"
      />
    </Pressable>
  );
}
