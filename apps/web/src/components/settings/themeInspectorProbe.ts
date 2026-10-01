import { getThemeColorVariable, type ThemeColorRole } from "../../themePalette";
import { THEME_HOVER_ID, THEME_SPOTLIGHT_ID } from "./themeInspectorOverlay";

export type ThemePaintKind = "background" | "border" | "foreground";

export type ThemePaintSnapshot = Readonly<Record<ThemePaintKind, string>>;

export type ThemeElementInspection = Readonly<{
  element: Element;
  role: ThemeColorRole;
}>;

export const THEME_PAINT_KIND_ORDER: ReadonlyArray<ThemePaintKind> = [
  "background",
  "border",
  "foreground",
];

const THEME_TOKEN_PROBE_ATTRIBUTE = "data-theme-token-probe";

// Sentinels no theme would plausibly use, so a probed token's paint always changes.
const THEME_TOKEN_PROBE_COLOR = "#01fea7";

const THEME_TOKEN_ALTERNATE_PROBE_COLOR = "#fe01a7";

function elementHasVisibleText(element: Element): boolean {
  if (element.matches("input, textarea, select, option")) return true;

  return Array.from(element.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
  );
}

export function getThemePaintSnapshot(
  element: Element,
  { forHitTest = false }: { forHitTest?: boolean } = {},
): ThemePaintSnapshot | null {
  const style = window.getComputedStyle(element);

  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return null;
  }

  const borderPaints: Array<string> = [];

  for (const [color, borderStyle, width] of [
    [style.borderTopColor, style.borderTopStyle, style.borderTopWidth],
    [style.borderRightColor, style.borderRightStyle, style.borderRightWidth],
    [style.borderBottomColor, style.borderBottomStyle, style.borderBottomWidth],
    [style.borderLeftColor, style.borderLeftStyle, style.borderLeftWidth],
  ] as const) {
    if (borderStyle !== "none" && Number.parseFloat(width) > 0) borderPaints.push(color);
  }

  if (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) {
    borderPaints.push(style.outlineColor);
  }

  if (style.borderImageSource !== "none") borderPaints.push(style.borderImageSource);

  if (style.boxShadow !== "none") borderPaints.push(style.boxShadow);

  const foregroundPaints: Array<string> = [];

  if (forHitTest || elementHasVisibleText(element)) foregroundPaints.push(style.color);

  if (element instanceof SVGElement) foregroundPaints.push(style.fill, style.stroke);

  if (element.matches("input, textarea")) foregroundPaints.push(style.caretColor);

  if (style.textDecorationLine !== "none") foregroundPaints.push(style.textDecorationColor);

  if (style.textShadow !== "none") foregroundPaints.push(style.textShadow);

  return {
    background: [style.backgroundColor, style.backgroundImage].join("\n"),
    border: borderPaints.join("\n"),
    foreground: foregroundPaints.join("\n"),
  };
}

export function changedThemePaintKinds(
  before: ThemePaintSnapshot,
  after: ThemePaintSnapshot,
): ReadonlyArray<ThemePaintKind> {
  return THEME_PAINT_KIND_ORDER.filter((kind) => before[kind] !== after[kind]);
}

export function withThemeTokenProbeSession<Result>(run: () => Result): Result {
  const root = document.documentElement;
  const wasAlreadyProbing = root.hasAttribute(THEME_TOKEN_PROBE_ATTRIBUTE);

  if (!wasAlreadyProbing) root.setAttribute(THEME_TOKEN_PROBE_ATTRIBUTE, "");

  try {
    return run();
  } finally {
    // Flush every restored token while transitions are still suppressed. The
    // browser never gets a paint opportunity between the probe and restore.
    void window.getComputedStyle(root).color;

    if (!wasAlreadyProbing) root.removeAttribute(THEME_TOKEN_PROBE_ATTRIBUTE);
  }
}

export function applyThemeTokenProbe(role: ThemeColorRole): () => void {
  const root = document.documentElement;
  const variable = getThemeColorVariable(role);
  const originalValue = root.style.getPropertyValue(variable);
  const originalPriority = root.style.getPropertyPriority(variable);
  const resolvedValue = originalValue.trim().toLowerCase();

  const probeColor =
    resolvedValue === THEME_TOKEN_PROBE_COLOR
      ? THEME_TOKEN_ALTERNATE_PROBE_COLOR
      : THEME_TOKEN_PROBE_COLOR;

  root.style.setProperty(variable, probeColor, "important");

  return () => {
    if (originalValue) {
      root.style.setProperty(variable, originalValue, originalPriority);
    } else {
      root.style.removeProperty(variable);
    }
  };
}

export function applyThemeTokenProbes(roles: ReadonlyArray<ThemeColorRole>): () => void {
  const restores = roles.map(applyThemeTokenProbe);

  return () => {
    for (const restore of restores.toReversed()) restore();
  };
}

export function themeInspectorCandidates(): ReadonlyArray<Element> {
  return [document.body, ...document.body.querySelectorAll("*")].filter(
    (element) =>
      !element.closest("[data-theme-editor-panel]") &&
      !element.closest(`#${THEME_SPOTLIGHT_ID}, #${THEME_HOVER_ID}`),
  );
}
