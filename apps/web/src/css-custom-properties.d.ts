import "react";

// Lets style props pass CSS custom properties, the channel for runtime values
// that classes such as `left-(--handle-left)` read.
declare module "react" {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}
