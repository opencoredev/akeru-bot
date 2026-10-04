declare module "react-dom/server" {
  import type { ReactElement } from "react";

  export function renderToStaticMarkup(element: ReactElement): string;
}
