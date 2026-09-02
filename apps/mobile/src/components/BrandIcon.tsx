import { Image } from "expo-image";

const source = require("../../../marketing/public/icon.png");

export function BrandIcon(props: { readonly borderRadius: number; readonly size: number }) {
  return (
    <Image
      source={source}
      accessibilityIgnoresInvertColors
      style={{ borderRadius: props.borderRadius, height: props.size, width: props.size }}
    />
  );
}
