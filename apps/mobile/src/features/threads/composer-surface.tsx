import type { ReactNode } from "react";
import { Platform, type ViewStyle } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";
import { GlassSurface } from "../../components/GlassSurface";

/**
 * Height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
 * Exported so the parent can compute feed overlap / content insets.
 */
export const COMPOSER_COLLAPSED_CHROME = 60;

/**
 * Height of the expanded composer (card + toolbar + vertical padding, excluding safe-area inset).
 * Used by the parent to compute the larger feed bottom inset when the composer is focused.
 */
export const COMPOSER_EXPANDED_CHROME = 156;

// One timing for every piece of the expanded↔compact morph so the surface,
// toolbar, and siblings move together instead of popping between layouts.
// Android gets NO layout transition: the composer rides the keyboard via
// KeyboardStickyView (frame-synced to the IME), and a time-based morph
// running alongside that translate reads as jitter. Snapping the layout and
// letting the keyboard-synced slide be the only motion looks native there.
export const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android" ? undefined : LinearTransition.duration(220);

/**
 * The pill / card container. Renders with Expo's native GlassView on supported
 * iOS 26+ devices and keeps the existing opaque fallback elsewhere.
 * Exported so NewTaskDraftScreen can render the same composer chrome.
 */
export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  readonly isDarkMode: boolean;
  /** Existing thread composers morph between pill and card layouts. */
  readonly animateLayout?: boolean;
}) {
  const cardColor = useThemeColor("--color-card-translucent");
  const borderColor = useThemeColor("--color-border");
  const shadowColor = useThemeColor("--color-primary-shadow");

  // Drop shadow lives on a wrapper: `overflow: "hidden"` on the surface itself
  // (needed to clip content to the pill shape) would clip the shadow on iOS.
  const shadowStyle: ViewStyle = {
    borderRadius: props.style.borderRadius,
    shadowColor,
    shadowOpacity: props.isDarkMode ? 0.35 : 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  };

  return (
    <Animated.View
      layout={props.animateLayout === false ? undefined : COMPOSER_LAYOUT_TRANSITION}
      style={shadowStyle}
    >
      <GlassSurface
        chrome="none"
        fallbackStyle={{
          backgroundColor: cardColor,
          borderWidth: 1,
          borderColor,
        }}
        glassEffectStyle="regular"
        // The composer is a passive material containing interactive controls.
        // Expo GlassView defaults to non-interactive and both layouts share it.
        tintColor="transparent"
        style={props.style}
      >
        {props.children}
      </GlassSurface>
    </Animated.View>
  );
}
