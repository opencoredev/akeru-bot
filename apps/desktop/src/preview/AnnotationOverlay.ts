import type { DesktopPreviewAnnotationTheme } from "@akeru/contracts";
import { PRIMARY, createButton } from "./AnnotationStyleControls.ts";
import { OVERLAY_ATTRIBUTE, CONTENT_LAYER_Z_INDEX, createBox } from "./AnnotationGeometry.ts";
import { previewAnnotationStyles } from "./AnnotationStyles.generated.ts";

const Z_INDEX_OVERLAY = 2147483646;

const CHROME_LAYER_Z_INDEX = 10;

export const PRIMARY_FILL = "color-mix(in srgb, var(--t3-primary) 10%, transparent)";

export const applyAnnotationTheme = (
  host: HTMLElement,
  theme: DesktopPreviewAnnotationTheme | null,
): void => {
  if (!theme) return;
  host.style.colorScheme = theme.colorScheme;

  const variables = {
    "--t3-radius": theme.radius,
    "--t3-background": theme.background,
    "--t3-foreground": theme.foreground,
    "--t3-popover": theme.popover,
    "--t3-popover-foreground": theme.popoverForeground,
    "--t3-primary": theme.primary,
    "--t3-primary-foreground": theme.primaryForeground,
    "--t3-muted": theme.muted,
    "--t3-muted-foreground": theme.mutedForeground,
    "--t3-accent": theme.accent,
    "--t3-accent-foreground": theme.accentForeground,
    "--t3-border": theme.border,
    "--t3-input": theme.input,
    "--t3-ring": theme.ring,
    "--t3-font-sans": theme.fontSans,
    "--t3-font-mono": theme.fontMono,
  };

  for (const [name, value] of Object.entries(variables)) {
    host.style.setProperty(name, value);
  }
};

export function createAnnotationOverlay(annotationTheme: DesktopPreviewAnnotationTheme | null) {
  const host = document.createElement("div");
  host.setAttribute(OVERLAY_ATTRIBUTE, "");
  host.style.cssText = `position:fixed;inset:0;z-index:${Z_INDEX_OVERLAY};pointer-events:none`;
  applyAnnotationTheme(host, annotationTheme);
  const shadowRoot = host.attachShadow({ mode: "closed" });
  const themeStyle = document.createElement("style");
  themeStyle.textContent = previewAnnotationStyles;
  shadowRoot.appendChild(themeStyle);

  const root = document.createElement("div");
  root.setAttribute(OVERLAY_ATTRIBUTE, "");
  root.className = "fixed inset-0 font-sans text-foreground";
  root.style.cssText = "pointer-events:none";
  const cursorStyle = document.createElement("style");
  cursorStyle.setAttribute(OVERLAY_ATTRIBUTE, "");
  cursorStyle.textContent = `html[data-t3code-annotation-tool] body, html[data-t3code-annotation-tool] body * { cursor: crosshair !important; } [${OVERLAY_ATTRIBUTE}], [${OVERLAY_ATTRIBUTE}] * { cursor: default !important; } [${OVERLAY_ATTRIBUTE}] input[type=number]::-webkit-inner-spin-button, [${OVERLAY_ATTRIBUTE}] input[type=number]::-webkit-outer-spin-button { appearance:none; margin:0; }`;
  document.documentElement.appendChild(cursorStyle);
  shadowRoot.appendChild(root);

  const hoverOutline = createBox(PRIMARY, PRIMARY_FILL);
  const marqueeBox = createBox(PRIMARY, PRIMARY_FILL);
  root.append(hoverOutline, marqueeBox);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute(OVERLAY_ATTRIBUTE, "");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
  svg.style.cssText = "position:fixed;inset:0;overflow:visible;pointer-events:none";
  svg.style.zIndex = String(CONTENT_LAYER_Z_INDEX);
  root.appendChild(svg);

  const toolbar = document.createElement("div");
  toolbar.setAttribute(OVERLAY_ATTRIBUTE, "");
  toolbar.className =
    "pointer-events-auto fixed top-2.5 left-1/2 flex -translate-x-1/2 gap-0.5 rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-xl";
  toolbar.style.zIndex = String(CHROME_LAYER_Z_INDEX);
  root.appendChild(toolbar);

  const editor = document.createElement("div");
  editor.setAttribute(OVERLAY_ATTRIBUTE, "");
  editor.className =
    "pointer-events-auto fixed hidden max-h-[calc(100vh-16px)] w-[min(360px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border border-border bg-popover/96 text-popover-foreground shadow-2xl backdrop-blur-xl";
  editor.style.zIndex = String(CHROME_LAYER_Z_INDEX);
  root.appendChild(editor);

  const composerRow = document.createElement("div");
  composerRow.className = "flex items-start gap-2 p-2";

  const adjust = createButton("", "Expand annotation editor");
  adjust.setAttribute("aria-label", "Expand annotation editor");
  adjust.setAttribute("aria-expanded", "false");
  adjust.className +=
    " h-8 w-8 shrink-0 bg-muted p-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground";
  adjust.innerHTML =
    '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h12M7 3v4M13 8v4M9 13v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  composerRow.appendChild(adjust);

  const comment = document.createElement("textarea");
  comment.placeholder = "Describe the change…";
  comment.rows = 1;
  comment.className =
    "min-h-8 max-h-24 min-w-0 flex-1 resize-none overflow-y-hidden border-0 border-b border-b-transparent bg-transparent px-0 py-1.5 font-sans text-sm leading-5 text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-b-primary focus:outline-none focus:ring-0";
  composerRow.appendChild(comment);

  const dragHandle = document.createElement("button");
  dragHandle.type = "button";
  dragHandle.textContent = "⠿";
  dragHandle.title = "Drag annotation editor";
  dragHandle.className =
    "hidden h-8 w-6 shrink-0 cursor-grab select-none border-0 bg-transparent p-0 font-sans text-lg font-bold leading-5 text-muted-foreground";
  composerRow.appendChild(dragHandle);

  const submit = createButton("Attach", "Attach annotation and screenshot (Enter)");
  submit.className +=
    " h-8 shrink-0 border-primary bg-primary px-3 text-primary-foreground shadow-sm hover:bg-primary/90";
  composerRow.appendChild(submit);
  editor.appendChild(composerRow);

  const stylePanel = document.createElement("div");
  stylePanel.className =
    "hidden max-h-[min(176px,calc(100vh-180px))] overflow-auto border-t border-border bg-muted/40 px-3";
  editor.appendChild(stylePanel);

  return {
    host,
    root,
    cursorStyle,
    hoverOutline,
    marqueeBox,
    svg,
    toolbar,
    editor,
    adjust,
    comment,
    dragHandle,
    submit,
    stylePanel,
  };
}
