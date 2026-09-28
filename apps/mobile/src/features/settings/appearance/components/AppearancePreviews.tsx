import { View } from "react-native";

import { AppText as Text } from "../../../../components/AppText";
import { resolveMarkdownFontSizes } from "../../../../lib/appearancePreferences";

/** Hairline between a section's preview surface and its control rows. */
export function AppearancePreviewSeparator() {
  return <View className="h-px bg-separator" />;
}

/** Live sample of body text rendered at the chosen base font size. */
export function TextAppearancePreview(props: { readonly fontSize: number }) {
  const sizes = resolveMarkdownFontSizes(props.fontSize);

  return (
    <View className="gap-1 p-4">
      <Text
        className="text-foreground"
        style={{ fontSize: sizes.m, lineHeight: sizes.bodyLineHeight }}
      >
        The quick brown fox jumps over the lazy dog.
      </Text>
      <Text
        className="text-foreground-muted"
        style={{ fontSize: sizes.s, lineHeight: Math.round(sizes.s * 1.4) }}
      >
        Messages, labels, and headings scale with this size.
      </Text>
    </View>
  );
}
