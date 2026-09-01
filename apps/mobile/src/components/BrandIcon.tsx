import Constants from "expo-constants";
import { Image } from "expo-image";

const source =
  Constants.expoConfig?.extra?.appVariant === "development"
    ? require("../../../../assets/dev/blueprint-ios-1024.png")
    : require("../../../marketing/public/icon.png");

export function BrandIcon(props: { readonly borderRadius: number; readonly size: number }) {
  return (
    <Image
      source={source}
      accessibilityIgnoresInvertColors
      style={{ borderRadius: props.borderRadius, height: props.size, width: props.size }}
    />
  );
}
