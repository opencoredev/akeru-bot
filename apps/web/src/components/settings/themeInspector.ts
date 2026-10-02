import { THEME_COLOR_ROLES, type ThemeColorRole } from "../../themePalette";
import {
  clearThemeInspectorAttribute,
  renderThemeInspectorSpotlight,
  THEME_INSPECTOR_MATCH_ATTRIBUTE,
  THEME_SPOTLIGHT_ID,
} from "./themeInspectorOverlay";
import {
  applyThemeTokenProbe,
  applyThemeTokenProbes,
  changedThemePaintKinds,
  getThemePaintSnapshot,
  THEME_PAINT_KIND_ORDER,
  themeInspectorCandidates,
  withThemeTokenProbeSession,
  type ThemeElementInspection,
  type ThemePaintKind,
  type ThemePaintSnapshot,
} from "./themeInspectorProbe";

export {
  clearThemeInspectorHighlights,
  clearThemeInspectorHover,
  refreshThemeInspectorSpotlight,
  showThemeInspectorHover,
  THEME_INSPECTOR_MATCH_ATTRIBUTE,
} from "./themeInspectorOverlay";

export {
  changedThemePaintKinds,
  type ThemeElementInspection,
  type ThemePaintKind,
  type ThemePaintSnapshot,
} from "./themeInspectorProbe";

const THEME_UTILITY_ROLES = new Map(
  Object.entries({
    background: "canvas",
    foreground: "text",
    card: "surface",
    "card-foreground": "text",
    popover: "surfaceOverlay",
    "popover-foreground": "text",
    "surface-raised": "surfaceRaised",
    primary: "messageAction",
    "primary-foreground": "messageActionForeground",
    secondary: "secondary",
    "secondary-foreground": "secondaryForeground",
    muted: "muted",
    "muted-foreground": "mutedForeground",
    placeholder: "placeholder",
    "secondary-label": "secondaryLabel",
    "icon-muted": "iconMuted",
    accent: "accentSurface",
    "accent-foreground": "accentSurfaceForeground",
    destructive: "error",
    "destructive-foreground": "errorForeground",
    error: "error",
    "error-foreground": "errorForeground",
    "error-surface": "errorSurface",
    warning: "warning",
    "warning-foreground": "warningForeground",
    "warning-surface": "warningSurface",
    update: "update",
    "update-foreground": "updateForeground",
    "update-surface": "updateSurface",
    message: "messageSurface",
    "message-foreground": "messageForeground",
    "message-action": "messageAction",
    "message-action-foreground": "messageActionForeground",
    "message-action-hover": "messageActionHover",
    sidebar: "sidebar",
    "sidebar-foreground": "sidebarForeground",
    "sidebar-muted-foreground": "sidebarMutedForeground",
    "sidebar-control-surface": "sidebarControlSurface",
    "sidebar-row-hover": "sidebarRowHover",
    "sidebar-row-active": "sidebarRowActive",
    "sidebar-row-selected": "sidebarRowSelected",
    "sidebar-border": "sidebarBorder",
    border: "border",
    input: "input",
    ring: "focus",
  } satisfies Record<string, ThemeColorRole>),
);

const THEME_UTILITY_PREFIXES: Readonly<Record<ThemePaintKind, ReadonlyArray<string>>> = {
  background: ["bg-"],
  border: ["border-", "outline-", "ring-"],
  foreground: ["text-", "caret-", "fill-", "stroke-"],
};

export function themeRoleFromUtilityClass(
  className: string,
  kind: ThemePaintKind,
): ThemeColorRole | null {
  // Stateful variants such as hover: and disabled: may not be contributing to
  // the current paint. The computed-style probe below handles those exactly.
  if (className.includes(":")) return null;

  for (const prefix of THEME_UTILITY_PREFIXES[kind]) {
    if (!className.startsWith(prefix)) continue;
    const colorName = className.slice(prefix.length).split("/", 1)[0] ?? "";

    return THEME_UTILITY_ROLES.get(colorName) ?? null;
  }

  return null;
}

function themeRoleFromUtilities(element: Element): ThemeColorRole | null {
  for (const kind of THEME_PAINT_KIND_ORDER) {
    for (const className of element.classList) {
      const role = themeRoleFromUtilityClass(className, kind);

      if (role) return role;
    }
  }

  return null;
}

function themeInspectionCandidates(initialElement: Element): ReadonlyArray<Element> {
  const candidates: Array<Element> = [];
  let element: Element | null = initialElement;

  while (element && element !== document.documentElement) {
    if (!element.closest("[data-theme-editor-panel]")) candidates.push(element);
    element = element.parentElement;
  }

  return candidates;
}

export function inspectThemeRoleFromUtilitiesAtElement(
  initialElement: Element,
): ThemeElementInspection | null {
  if (initialElement.closest("[data-theme-editor-panel]")) return null;

  for (const candidate of themeInspectionCandidates(initialElement)) {
    const role = themeRoleFromUtilities(candidate);

    if (role) return { element: candidate, role };
  }

  return null;
}

/**
 * Finds actual dependency on a theme token instead of comparing final colors.
 * A token is synchronously replaced with a sentinel, computed paint is read,
 * and the original value is restored before the browser can render a frame.
 */
export function highlightThemeRoleUsage(roles: ReadonlyArray<ThemeColorRole>): number {
  const startedAt = performance.now();
  clearThemeInspectorAttribute(THEME_INSPECTOR_MATCH_ATTRIBUTE);
  const candidates = themeInspectorCandidates();
  const probeStartedAt = performance.now();

  const matches = withThemeTokenProbeSession(() => {
    const baseline = new Map<Element, ThemePaintSnapshot>();

    for (const element of candidates) {
      const snapshot = getThemePaintSnapshot(element);

      if (snapshot) baseline.set(element, snapshot);
    }

    const restore = applyThemeTokenProbes(roles);
    const changed = new Set<Element>();

    try {
      for (const [element, before] of baseline) {
        const after = getThemePaintSnapshot(element);

        if (after && changedThemePaintKinds(before, after).length > 0) changed.add(element);
      }
    } finally {
      restore();
    }

    return changed;
  });

  const probeDuration = performance.now() - probeStartedAt;

  const highlightedElements = new Set<Element>();

  for (const element of matches) {
    highlightedElements.add(
      element instanceof SVGElement ? (element.closest("svg") ?? element) : element,
    );
  }

  for (const element of highlightedElements) {
    element.setAttribute(THEME_INSPECTOR_MATCH_ATTRIBUTE, "");
  }

  renderThemeInspectorSpotlight([...highlightedElements]);

  if (import.meta.env.DEV) {
    const spotlight = document.getElementById(THEME_SPOTLIGHT_ID);

    if (spotlight) {
      spotlight.dataset.themeInspectorCandidates = String(candidates.length);
      spotlight.dataset.themeInspectorProbeMs = probeDuration.toFixed(2);
      spotlight.dataset.themeInspectorTotalMs = (performance.now() - startedAt).toFixed(2);
    }
  }

  return highlightedElements.size;
}

/** Resolves the nearest painted token at a touched element. */
export function inspectThemeRoleAtElement(initialElement: Element): ThemeElementInspection | null {
  if (initialElement.closest("[data-theme-editor-panel]")) return null;

  const candidates = themeInspectionCandidates(initialElement);

  // Most app paint comes from Tailwind's semantic color utilities. Those class
  // names express the token dependency directly and avoid dozens of forced
  // style recalculations on every pointer-down. Custom CSS still falls through
  // to the exact computed-style probe.
  const utilityInspection = inspectThemeRoleFromUtilitiesAtElement(initialElement);

  if (utilityInspection) return utilityInspection;

  const rolesByElement = withThemeTokenProbeSession(() => {
    const baseline = new Map<Element, ThemePaintSnapshot>();
    const roles = new Map<Element, Partial<Record<ThemePaintKind, ThemeColorRole>>>();

    for (const candidate of candidates) {
      const snapshot = getThemePaintSnapshot(candidate, { forHitTest: true });

      if (snapshot) baseline.set(candidate, snapshot);
    }

    for (const role of THEME_COLOR_ROLES) {
      const restore = applyThemeTokenProbe(role);

      try {
        for (const [candidate, before] of baseline) {
          const after = getThemePaintSnapshot(candidate, { forHitTest: true });

          if (!after) continue;
          const candidateRoles = roles.get(candidate) ?? {};

          for (const kind of changedThemePaintKinds(before, after)) {
            candidateRoles[kind] ??= role;
          }

          roles.set(candidate, candidateRoles);
        }
      } finally {
        restore();
      }
    }

    return roles;
  });

  for (const candidate of candidates) {
    const roles = rolesByElement.get(candidate);

    if (!roles) continue;

    for (const kind of THEME_PAINT_KIND_ORDER) {
      const role = roles[kind];

      if (role) return { element: candidate, role };
    }
  }

  return null;
}
