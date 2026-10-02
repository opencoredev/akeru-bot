import { View } from "react-native";

/** Thin determinate progress bar pinned to the top of its parent. */
export function LoadingStrip(props: { readonly progress: number }) {
  const clampedProgress = Math.min(1, Math.max(0, props.progress));

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden"
    >
      <View
        className="h-full rounded-r-full bg-primary"
        style={{ width: `${clampedProgress * 100}%` }}
      />
    </View>
  );
}
