import { createContext } from "react";
import type { MarkdownImageRenderer } from "./SelectableMarkdownText.types";

/** Set by SelectableMarkdownText so images anywhere in the block tree can use it. */
export const MarkdownImageRendererContext = createContext<MarkdownImageRenderer | null>(null);
