import { Schema } from "effect";
import { useCSSVariable } from "uniwind";

const decodeThemeColor = Schema.decodeUnknownSync(Schema.Union([Schema.String, Schema.Undefined]));

/**
 * Typed wrapper around `useCSSVariable` that returns an optional color string for use
 * in React Native style props (backgroundColor, tintColor, etc.).
 *
 * Usage: `const color = useThemeColor("--color-icon");`
 */
export function useThemeColor(variable: `--color-${string}`): string | undefined {
  return decodeThemeColor(useCSSVariable(variable));
}
