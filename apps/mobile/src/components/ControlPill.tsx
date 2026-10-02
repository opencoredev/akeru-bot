import { Match } from "effect";
import { MenuView } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import { cloneElement, isValidElement, type ComponentProps, type ReactNode, useRef } from "react";
import { Platform, Pressable, View } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

import { cn } from "../lib/cn";
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu";
import { SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";

export function ControlPill(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label?: string;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly onPress?: () => void;
  readonly activateOnPressIn?: boolean;
  readonly variant?: "circle" | "pill" | "primary" | "danger";
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const variant = props.variant ?? "circle";
  const activatedOnPressInRef = useRef(false);

  const handlePressIn = () => {
    activatedOnPressInRef.current = true;
    props.onPress?.();
  };

  const handlePressOut = () => {
    // Pressability invokes onPressOut immediately before onPress on release.
    // Defer the reset so onPress can identify the same physical gesture.
    setTimeout(() => {
      activatedOnPressInRef.current = false;
    }, 0);
  };

  const handlePress = () => {
    if (activatedOnPressInRef.current) {
      return;
    }

    props.onPress?.();
  };

  const iconColor = useThemeColor("--color-icon");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerFg = useThemeColor("--color-danger-foreground");

  const iconTintColor = Match.value(variant).pipe(
    Match.when("primary", () => (props.disabled ? iconSubtle : primaryFg)),
    Match.when("danger", () => dangerFg),
    Match.orElse(() => iconColor),
  );

  const isCircle =
    variant === "circle" || variant === "danger" || (variant === "primary" && !props.label);

  const containerClassName = cn(
    isCircle
      ? "h-11 w-11 items-center justify-center rounded-full"
      : variant === "primary"
        ? "h-11 flex-row items-center justify-center gap-2 rounded-full px-5"
        : "h-11 flex-row items-center justify-center gap-2 rounded-full px-3.5",
    Match.value(variant).pipe(
      Match.when("primary", () => (props.disabled ? "bg-subtle-strong" : "bg-primary")),
      Match.when("danger", () => "bg-danger"),
      Match.orElse(() => "bg-subtle"),
    ),
    props.className,
  );

  const labelClassName = cn(
    "text-center text-xs font-t3-bold",
    variant === "primary"
      ? props.disabled
        ? "text-foreground-muted"
        : "text-primary-foreground"
      : "",
  );

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      onPress={props.activateOnPressIn ? handlePress : props.onPress}
      onPressIn={props.activateOnPressIn ? handlePressIn : undefined}
      onPressOut={props.activateOnPressIn ? handlePressOut : undefined}
      disabled={props.disabled}
      className={containerClassName}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView name={props.icon} size={16} tintColor={iconTintColor} type="monochrome" />
      ) : null}
      {props.label ? <Text className={labelClassName}>{props.label}</Text> : null}
    </Pressable>
  );
}

// iOS renders the native UIMenu (standard checkmark for `state: "on"`);
// Android renders the token-styled AndroidAnchoredMenu, since the native
// AppCompat popup can't be themed past its stock animation, metrics, and
// submenu chrome.
export function ControlPillMenu(
  props: Omit<ComponentProps<typeof MenuView>, "children" | "themeVariant"> & {
    readonly children: ReactNode;
    readonly className?: string;
  },
) {
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";

  if (Platform.OS === "android") {
    // Long-press menus keep their child interactive: the child element gets
    // an injected onLongPress (mirroring the iOS context-menu interaction)
    // so its own tap handling still works.
    if (
      props.shouldOpenOnLongPress &&
      isValidElement<{ onLongPress?: () => void }>(props.children)
    ) {
      const child = props.children;

      return (
        <AndroidAnchoredMenu
          actions={props.actions}
          className={props.className}
          title={props.title}
          style={props.style}
          onPressAction={props.onPressAction}
        >
          {(open) =>
            cloneElement(child, {
              onLongPress: () => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                open();
              },
            })
          }
        </AndroidAnchoredMenu>
      );
    }

    return (
      <AndroidAnchoredMenu
        actions={props.actions}
        className={props.className}
        title={props.title}
        style={props.style}
        onPressAction={props.onPressAction}
      >
        {props.children}
      </AndroidAnchoredMenu>
    );
  }

  const { className: _className, ...menuProps } = props;
  let children = menuProps.children;

  // In long-press mode the wrapped pressable still receives the touch (the
  // patched MenuView button is touch-transparent) and RN's Fabric touch
  // handler is never cancelled by the in-tree UIContextMenuInteraction, so a
  // bare onPress would fire on finger-up even after the menu opened — and
  // also on a long press released just under the menu threshold. A dispatched
  // onLongPress makes Pressability swallow the release, so holds past 350ms
  // (below the ~500ms context-menu threshold) can only open the menu, never
  // tap through.
  if (
    props.shouldOpenOnLongPress &&
    isValidElement<{ onLongPress?: () => void; delayLongPress?: number }>(children)
  ) {
    const child = children;
    children = cloneElement(child, {
      onLongPress: child.props.onLongPress ?? (() => undefined),
      delayLongPress: child.props.delayLongPress ?? 350,
    });
  }

  return (
    <MenuView {...menuProps} themeVariant={isDarkMode ? "dark" : "light"}>
      {children}
    </MenuView>
  );
}
