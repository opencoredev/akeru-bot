import * as Haptics from "expo-haptics";
import { use, useCallback, useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import { View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { runOnJS, type SharedValue, useAnimatedReaction } from "react-native-reanimated";
import { useMobileI18n } from "../../lib/i18n";
import {
  ACTION_ITEM_WIDTH,
  SwipeActionButton,
  type ThreadSwipeAction,
} from "./thread-swipe-action-button";
import { SwipeableScrollGateContext } from "./swipeable-scroll-gate";

export { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./swipeable-scroll-gate";

export const THREAD_SWIPE_ACTIONS_WIDTH = ACTION_ITEM_WIDTH * 2;

export const THREAD_SWIPE_SPRING = {
  damping: 26,
  mass: 0.7,
  overshootClamping: true,
  stiffness: 330,
};

interface ThreadSwipeSecondaryAction extends ThreadSwipeAction {
  readonly backgroundColor: string;
}

function swipeActionsWidth(hasSecondaryAction: boolean) {
  return hasSecondaryAction ? THREAD_SWIPE_ACTIONS_WIDTH : ACTION_ITEM_WIDTH;
}

/** `undefined` keeps the v1 Delete default; `null` means one action only. */
function resolveSecondaryAction(input: {
  readonly close: () => void;
  readonly onDelete: () => void;
  readonly secondaryAction: ThreadSwipeAction | null | undefined;
  readonly t: ReturnType<typeof useMobileI18n>["t"];
  readonly threadTitle: string;
}): ThreadSwipeSecondaryAction | null {
  if (input.secondaryAction === null) return null;

  if (input.secondaryAction === undefined) {
    return {
      accessibilityLabel: input.t("Delete {title}", { title: input.threadTitle }),
      backgroundColor: "#ff2d55",
      icon: "trash",
      label: input.t("Delete"),
      onPress: () => {
        input.close();
        input.onDelete();
      },
    };
  }

  const action = input.secondaryAction;

  return {
    ...action,
    backgroundColor: "#5856d6",
    menu:
      action.menu === undefined
        ? undefined
        : {
            ...action.menu,
            onPressAction: (event) => {
              input.close();
              action.menu?.onPressAction(event);
            },
          },
    onPress: () => {
      input.close();
      action.onPress();
    },
  };
}

export function ThreadSwipeable(props: {
  readonly backgroundColor: ColorValue;
  readonly children: (close: () => void) => ReactNode;
  /** Uses action visuals that fit inside compact 44pt rows. The press target
   * still spans the row's full height and width. */
  readonly compactActions?: boolean;
  readonly containerStyle?: StyleProp<ViewStyle>;
  /** Disables NEW swipe activations (e.g. while the list scrolls). */
  readonly enabled?: boolean;
  readonly enableTrackpadSwipe?: boolean;
  /**
   * What a full swipe commits. Omitted keeps the v1 Delete behavior only when
   * the built-in Delete secondary action is in use; custom or absent
   * secondary actions default to the advertised primary action.
   */
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeWidth: number;
  readonly onDelete: () => void;
  readonly onSwipeableClose?: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen?: (methods: SwipeableMethods) => void;
  readonly primaryAction: ThreadSwipeAction;
  /**
   * Omitted keeps the v1 destructive Delete action. Explicit null opts out of
   * a secondary action entirely so a gated Snooze can never fall back to an
   * unadvertised Delete.
   */
  readonly secondaryAction?: ThreadSwipeAction | null;
  /**
   * Identity of the content being wrapped. When a recycled list reuses this
   * component for a different item, the swipeable snaps back to closed so an
   * open/mid-drag state can't leak onto another row.
   */
  readonly resetKey?: string;
  readonly simultaneousWithExternalGesture?: ComponentProps<
    typeof ReanimatedSwipeable
  >["simultaneousWithExternalGesture"];
  readonly threadTitle: string;
}) {
  const { t } = useMobileI18n();
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const fullSwipeArmedRef = useRef(false);
  const hasSecondaryAction = props.secondaryAction !== null;
  const actionsWidth = swipeActionsWidth(hasSecondaryAction);
  const fullSwipeThreshold = Math.max(actionsWidth + 44, props.fullSwipeWidth * 0.58);

  const fullSwipeAction =
    props.fullSwipeAction ?? (props.secondaryAction === undefined ? "delete" : "primary");

  const close = useCallback(() => swipeableRef.current?.close(), []);
  const gateEnabled = use(SwipeableScrollGateContext);
  const resetKey = props.resetKey;
  useEffect(() => {
    if (resetKey === undefined) {
      return;
    }

    fullSwipeArmedRef.current = false;
    swipeableRef.current?.reset();
  }, [resetKey]);

  const handleFullSwipeArmedChange = useCallback((armed: boolean) => {
    if (armed && !fullSwipeArmedRef.current) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    fullSwipeArmedRef.current = armed;
  }, []);

  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      animationOptions={THREAD_SWIPE_SPRING}
      childrenContainerStyle={{ backgroundColor: props.backgroundColor }}
      containerStyle={[{ backgroundColor: props.backgroundColor }, props.containerStyle]}
      dragOffsetFromRightEdge={8}
      enabled={props.enabled !== false && gateEnabled}
      enableTrackpadTwoFingerGesture={props.enableTrackpadSwipe ?? true}
      // Fail the swipe once the pan is vertically dominant (patched-in RNGH
      // prop) — otherwise trackpad scrolls with ~8px of horizontal drift
      // start opening rows because the swipe pan runs simultaneously with
      // the list scroll gesture and never gets disqualified by Y movement.
      failOffsetY={[-10, 10]}
      friction={1}
      onSwipeableClose={() => {
        fullSwipeArmedRef.current = false;

        if (swipeableRef.current) {
          props.onSwipeableClose?.(swipeableRef.current);
        }
      }}
      onSwipeableOpenStartDrag={() => {
        if (swipeableRef.current) {
          props.onSwipeableWillOpen?.(swipeableRef.current);
        }
      }}
      onSwipeableWillOpen={() => {
        const methods = swipeableRef.current;

        if (!methods) {
          return;
        }

        props.onSwipeableWillOpen?.(methods);

        if (fullSwipeArmedRef.current) {
          fullSwipeArmedRef.current = false;
          methods.close();

          if (fullSwipeAction === "primary") {
            props.primaryAction.onPress();
          } else {
            props.onDelete();
          }
        }
      }}
      overshootFriction={1}
      overshootRight
      renderRightActions={(_progress, translation, methods) => (
        <ThreadSwipeActions
          backgroundColor={props.backgroundColor}
          compact={props.compactActions === true}
          fullSwipeAction={fullSwipeAction}
          fullSwipeThreshold={fullSwipeThreshold}
          onFullSwipeArmedChange={handleFullSwipeArmedChange}
          primaryAction={{
            ...props.primaryAction,
            onPress: () => {
              methods.close();
              props.primaryAction.onPress();
            },
          }}
          secondaryAction={resolveSecondaryAction({
            close: () => methods.close(),
            onDelete: props.onDelete,
            secondaryAction: props.secondaryAction,
            t,
            threadTitle: props.threadTitle,
          })}
          translation={translation}
        />
      )}
      rightThreshold={actionsWidth * 0.42}
      simultaneousWithExternalGesture={props.simultaneousWithExternalGesture}
    >
      {props.children(close)}
    </ReanimatedSwipeable>
  );
}

export function ThreadSwipeActions(props: {
  readonly backgroundColor: ColorValue;
  readonly compact: boolean;
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeThreshold: number;
  readonly onFullSwipeArmedChange: (armed: boolean) => void;
  readonly primaryAction: ThreadSwipeAction;
  readonly secondaryAction: ThreadSwipeSecondaryAction | null;
  readonly translation: SharedValue<number>;
}) {
  const secondaryAction = props.secondaryAction;
  const fullSwipeIsPrimary = props.fullSwipeAction === "primary" || secondaryAction === null;
  const actionsWidth = swipeActionsWidth(secondaryAction !== null);
  useAnimatedReaction(
    () => -props.translation.value >= props.fullSwipeThreshold,
    (armed, previous) => {
      if (armed !== previous) {
        runOnJS(props.onFullSwipeArmedChange)(armed);
      }
    },
    [props.fullSwipeThreshold, props.onFullSwipeArmedChange],
  );

  return (
    <View
      style={{
        backgroundColor: props.backgroundColor,
        flexDirection: "row",
        height: "100%",
        width: actionsWidth,
      }}
    >
      <SwipeActionButton
        accessibilityLabel={props.primaryAction.accessibilityLabel}
        actionsWidth={actionsWidth}
        backgroundColor="#007aff"
        compact={props.compact}
        entryRange={
          secondaryAction === null
            ? [8, ACTION_ITEM_WIDTH * 0.72]
            : [ACTION_ITEM_WIDTH * 0.55, THREAD_SWIPE_ACTIONS_WIDTH * 0.85]
        }
        fullSwipeThreshold={props.fullSwipeThreshold}
        icon={props.primaryAction.icon}
        label={props.primaryAction.label}
        onPress={props.primaryAction.onPress}
        stretchesOnFullSwipe={fullSwipeIsPrimary}
        translation={props.translation}
      />
      {secondaryAction === null ? null : (
        <SwipeActionButton
          accessibilityLabel={secondaryAction.accessibilityLabel}
          actionsWidth={actionsWidth}
          backgroundColor={secondaryAction.backgroundColor}
          compact={props.compact}
          entryRange={[8, ACTION_ITEM_WIDTH * 0.72]}
          fullSwipeThreshold={props.fullSwipeThreshold}
          icon={secondaryAction.icon}
          label={secondaryAction.label}
          menu={secondaryAction.menu}
          onPress={secondaryAction.onPress}
          stretchesOnFullSwipe={!fullSwipeIsPrimary}
          translation={props.translation}
        />
      )}
    </View>
  );
}
