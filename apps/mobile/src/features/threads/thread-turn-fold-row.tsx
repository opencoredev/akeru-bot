import type { TurnId } from "@akeru/contracts";
import { Pressable, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import type { ThreadFeedEntry } from "../../lib/threadActivityTypes";

export function ThreadTurnFoldRow(props: {
  readonly entry: Extract<ThreadFeedEntry, { readonly type: "turn-fold" }>;
  readonly onToggle: (turnId: TurnId) => void;
  readonly iconColor: ColorValue | undefined;
}) {
  const { entry } = props;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: entry.expanded }}
      onPress={() => props.onToggle(entry.turnId)}
      hitSlop={4}
      className="mb-3 min-h-11 flex-row items-center gap-2 border-b border-work-fold-separator px-2"
    >
      <Text className="font-t3-medium text-sm tabular-nums text-foreground-muted">
        {entry.label}
      </Text>
      <SymbolView
        name={entry.expanded ? "chevron.down" : "chevron.right"}
        size={15}
        tintColor={props.iconColor}
        type="monochrome"
      />
    </Pressable>
  );
}
