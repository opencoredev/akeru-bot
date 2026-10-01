import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import type { MenuAction } from "@react-native-menu/menu";
import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
} from "react-native-reanimated";
import { AppText as Text } from "../../components/AppText";

// Wide enough for the longest action label ("Unarchive").
export const ACTION_ITEM_WIDTH = 58;
const ACTION_CIRCLE_SIZE = 36;
const ACTION_ICON_SIZE = 15;
const COMPACT_ACTION_CIRCLE_SIZE = 28;
const COMPACT_ACTION_ICON_SIZE = 13;

export interface ThreadSwipeAction {
  readonly accessibilityLabel: string;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly menu?: {
    readonly actions: MenuAction[];
    readonly onPressAction: NonNullable<ComponentProps<typeof ControlPillMenu>["onPressAction"]>;
    readonly title?: string;
  };
  readonly onPress: () => void;
}

export function SwipeActionButton(props: {
  readonly accessibilityLabel: string;
  readonly actionsWidth: number;
  readonly backgroundColor: string;
  readonly compact: boolean;
  readonly entryRange: readonly [number, number];
  readonly fullSwipeThreshold: number;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly menu?: ThreadSwipeAction["menu"];
  readonly onPress: () => void;
  readonly stretchesOnFullSwipe: boolean;
  readonly translation: SharedValue<number>;
}) {
  const circleSize = props.compact ? COMPACT_ACTION_CIRCLE_SIZE : ACTION_CIRCLE_SIZE;
  const iconSize = props.compact ? COMPACT_ACTION_ICON_SIZE : ACTION_ICON_SIZE;
  const actionStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0);
    const entryProgress = interpolate(reveal, props.entryRange, [0, 1], Extrapolation.CLAMP);
    const stretch = Math.max(reveal - props.actionsWidth, 0);
    const fullSwipeProgress = interpolate(
      reveal,
      [props.actionsWidth, props.fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      opacity: props.stretchesOnFullSwipe ? entryProgress : entryProgress * (1 - fullSwipeProgress),
      transform: [
        {
          translateX:
            interpolate(entryProgress, [0, 1], [22, 0]) -
            (props.stretchesOnFullSwipe ? 0 : stretch),
        },
        { scale: interpolate(entryProgress, [0, 1], [0.78, 1]) },
      ],
    };
  });
  const circleStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0);
    const stretch = props.stretchesOnFullSwipe ? Math.max(reveal - props.actionsWidth, 0) : 0;

    return {
      transform: [{ translateX: -stretch }],
      width: circleSize + stretch,
    };
  });
  const iconStyle = useAnimatedStyle(() => {
    const reveal = Math.max(-props.translation.value, 0);
    const stretch = props.stretchesOnFullSwipe ? Math.max(reveal - props.actionsWidth, 0) : 0;
    const armedProgress = interpolate(
      reveal,
      [props.fullSwipeThreshold, props.fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      transform: [{ translateX: -stretch * (0.5 + armedProgress * 0.5) }],
    };
  });
  const labelStyle = useAnimatedStyle(() => {
    if (!props.stretchesOnFullSwipe) {
      return { opacity: 1 };
    }

    const reveal = Math.max(-props.translation.value, 0);
    const stretch = Math.max(reveal - props.actionsWidth, 0);
    return {
      opacity: interpolate(
        reveal,
        [props.fullSwipeThreshold - 24, props.fullSwipeThreshold],
        [1, 0],
        Extrapolation.CLAMP,
      ),
      transform: [{ translateX: -stretch * 0.5 }],
    };
  });

  const button = (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      onPress={props.menu === undefined ? props.onPress : undefined}
      style={({ pressed }) => ({
        alignItems: "center",
        height: "100%",
        justifyContent: "center",
        opacity: pressed ? 0.72 : 1,
        width: "100%",
      })}
    >
      <View style={{ height: circleSize, width: circleSize }}>
        <Animated.View
          style={[
            {
              backgroundColor: props.backgroundColor,
              borderRadius: 999,
              height: circleSize,
              left: 0,
              position: "absolute",
              top: 0,
            },
            circleStyle,
          ]}
        />
        <Animated.View
          style={[
            {
              alignItems: "center",
              height: circleSize,
              justifyContent: "center",
              left: 0,
              position: "absolute",
              top: 0,
              width: circleSize,
            },
            iconStyle,
          ]}
        >
          <SymbolView name={props.icon} size={iconSize} tintColor="#ffffff" type="monochrome" />
        </Animated.View>
      </View>
      <Animated.View
        style={[
          { height: 14, justifyContent: "center", paddingTop: props.compact ? 0 : 2 },
          labelStyle,
        ]}
      >
        <Text className="text-3xs font-t3-medium text-foreground-muted" numberOfLines={1}>
          {props.label}
        </Text>
      </Animated.View>
    </Pressable>
  );

  return (
    <Animated.View
      style={[
        {
          alignItems: "center",
          height: "100%",
          justifyContent: "center",
          width: ACTION_ITEM_WIDTH,
          zIndex: props.stretchesOnFullSwipe ? 2 : 1,
        },
        actionStyle,
      ]}
    >
      {props.menu === undefined ? (
        button
      ) : (
        <ControlPillMenu
          actions={props.menu.actions}
          onPressAction={props.menu.onPressAction}
          title={props.menu.title}
          style={{ height: "100%", width: "100%" }}
        >
          {button}
        </ControlPillMenu>
      )}
    </Animated.View>
  );
}
