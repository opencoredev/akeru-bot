import { Schema } from "effect";
import { useCSSVariable } from "uniwind";

const decodeThemeColor = Schema.decodeUnknownSync(Schema.String);

/**
 * Typed wrapper around `useCSSVariable` that returns a `ColorValue` for use
 * in React Native style props (backgroundColor, tintColor, etc.).
 *
 * Usage: `const color = useThemeColor("--color-icon");`
 */
export function useThemeColor(variable: `--color-${string}`): string {
  return decodeThemeColor(useCSSVariable(variable));
}
