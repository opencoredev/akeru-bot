import { useCallback, useEffect, useState, type RefObject } from "react";
import { THEME_COLOR_ROLES, type ThemeColorRole, type ThemeColors } from "../../themePalette";
import {
  getThemeEditorColorFamily,
  getThemeEditorRoleLabel,
  THEME_EDITOR_SIMPLE_ROLES,
} from "./themeEditorRoles";
import {
  clearThemeInspectorHighlights,
  clearThemeInspectorHover,
  highlightThemeRoleUsage,
  inspectThemeRoleAtElement,
  inspectThemeRoleFromUtilitiesAtElement,
  refreshThemeInspectorSpotlight,
  showThemeInspectorHover,
  type ThemeElementInspection,
} from "./themeInspector";

/**
 * Role selection and live DOM inspection for the theme editor: spotlights
 * where the selected role paints the app, and arms a picker that resolves the
 * role under a clicked element. Every listener and overlay it adds is removed
 * when the editor closes or the selection clears. `onRevealAdvancedRole` runs
 * when a picked role is only editable in advanced mode and must be stable.
 */
export function useThemeEditorInspector({
  open,
  isAdvanced,
  activeColors,
  panelRef,
  onRevealAdvancedRole,
}: {
  open: boolean;
  isAdvanced: boolean;
  activeColors: ThemeColors;
  panelRef: RefObject<HTMLDivElement | null>;
  onRevealAdvancedRole: () => void;
}) {
  const [isInspecting, setIsInspecting] = useState(false);
  const [selectedRole, setSelectedRole] = useState<ThemeColorRole | null>(null);
  const [usageCount, setUsageCount] = useState<number | null>(null);

  const selectThemeRole = useCallback(
    (role: ThemeColorRole, reveal = false) => {
      const visibleRole = getThemeEditorColorFamily(role)?.role ?? role;
      setSelectedRole(visibleRole);

      if (!THEME_EDITOR_SIMPLE_ROLES.includes(visibleRole)) onRevealAdvancedRole();

      if (!reveal) return;

      requestAnimationFrame(() => {
        panelRef.current
          ?.querySelector(`[data-theme-color-role="${visibleRole}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    },
    [onRevealAdvancedRole, panelRef],
  );

  const toggleThemeRole = useCallback((role: ThemeColorRole) => {
    setSelectedRole((current) => (current === role ? null : role));
  }, []);

  const clearInspectorSelection = useCallback(() => {
    setSelectedRole(null);
    setUsageCount(null);
    setIsInspecting(false);
  }, []);

  const selectedHighlightRoles = selectedRole
    ? isAdvanced
      ? (getThemeEditorColorFamily(selectedRole)?.roles ?? [selectedRole])
      : THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)
        ? THEME_COLOR_ROLES.filter(
            (role) =>
              activeColors[role].trim().toLowerCase() ===
              activeColors[selectedRole].trim().toLowerCase(),
          )
        : [selectedRole]
    : [];

  const selectedHighlightRolesKey = selectedHighlightRoles.join(",");

  useEffect(() => {
    clearThemeInspectorHighlights();

    if (!open || selectedRole === null) {
      setUsageCount(null);

      return;
    }

    // Picking a new element needs the unobscured app, so suspend the existing
    // spotlight while the picker is armed.
    if (isInspecting) return;

    const highlightedRoleSet = new Set(selectedHighlightRolesKey.split(","));
    const highlightedRoles = THEME_COLOR_ROLES.filter((role) => highlightedRoleSet.has(role));
    const refreshHighlights = () => setUsageCount(highlightThemeRoleUsage(highlightedRoles));
    refreshHighlights();
    // A refresh snapshots computed styles for the whole tree twice, so it is
    // throttled rather than run per frame: a streaming reply or a virtualized
    // list mutates the DOM continuously and would otherwise stall the main
    // thread for as long as the inspector is open.
    const MIN_REFRESH_INTERVAL_MS = 500;
    let refreshFrame: number | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = performance.now();

    const scheduleRefresh = () => {
      if (refreshFrame !== null || refreshTimer !== null) return;
      const wait = Math.max(0, MIN_REFRESH_INTERVAL_MS - (performance.now() - lastRefreshAt));

      const run = () => {
        refreshFrame = null;
        refreshTimer = null;
        lastRefreshAt = performance.now();
        refreshHighlights();
      };

      if (wait === 0) refreshFrame = requestAnimationFrame(run);
      else refreshTimer = setTimeout(run, wait);
    };

    const observer = new MutationObserver((mutations) => {
      if (
        mutations.every(
          (mutation) =>
            mutation.target instanceof Element &&
            (mutation.target.closest("#theme-inspector-spotlight") ||
              mutation.target.closest("[data-theme-editor-panel]")),
        )
      ) {
        return;
      }

      scheduleRefresh();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    let spotlightFrame: number | null = null;

    const scheduleSpotlightRefresh = () => {
      spotlightFrame ??= requestAnimationFrame(() => {
        spotlightFrame = null;
        refreshThemeInspectorSpotlight();
      });
    };

    window.addEventListener("resize", scheduleSpotlightRefresh);
    window.addEventListener("scroll", scheduleSpotlightRefresh, true);

    return () => {
      observer.disconnect();

      if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);

      if (refreshTimer !== null) clearTimeout(refreshTimer);

      if (spotlightFrame !== null) cancelAnimationFrame(spotlightFrame);
      window.removeEventListener("resize", scheduleSpotlightRefresh);
      window.removeEventListener("scroll", scheduleSpotlightRefresh, true);
      clearThemeInspectorHighlights();
    };
  }, [isInspecting, open, selectedHighlightRolesKey, selectedRole]);

  useEffect(() => {
    if (!open || !isInspecting) {
      clearThemeInspectorHover();

      return;
    }

    let shouldDisarmAfterClick = false;
    let hoverTarget: Element | null = null;
    let hoverInspection: ThemeElementInspection | null = null;
    let hoverTimer: number | null = null;
    let hoverFrame: number | null = null;

    const clearHoverTimer = () => {
      if (hoverTimer === null) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = null;
    };

    const clearHover = () => {
      clearHoverTimer();
      hoverTarget = null;
      hoverInspection = null;
      clearThemeInspectorHover();
    };

    const showInspection = (inspection: ThemeElementInspection) => {
      hoverInspection = inspection;
      showThemeInspectorHover(inspection, getThemeEditorRoleLabel(inspection.role));
    };

    const handlePointerOver = (event: PointerEvent) => {
      const target = event.target;

      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) {
        clearHover();

        return;
      }

      clearHoverTimer();
      hoverTarget = target;
      hoverInspection = null;
      const utilityInspection = inspectThemeRoleFromUtilitiesAtElement(target);

      if (utilityInspection) {
        showInspection(utilityInspection);

        return;
      }

      clearThemeInspectorHover();
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;

        if (hoverTarget !== target || !target.isConnected) return;
        const inspection = inspectThemeRoleAtElement(target);

        if (inspection) showInspection(inspection);
      }, 140);
    };

    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) clearHover();
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      clearHoverTimer();

      const inspection =
        hoverTarget === target && hoverInspection
          ? hoverInspection
          : inspectThemeRoleAtElement(target);

      if (!inspection) return;
      clearHover();
      selectThemeRole(inspection.role, true);
      shouldDisarmAfterClick = true;
    };

    const blockInspectedClick = (event: MouseEvent) => {
      const target = event.target;

      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();

      if (shouldDisarmAfterClick) setIsInspecting(false);
      shouldDisarmAfterClick = false;
    };

    const cancelInspection = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      clearHover();
      clearInspectorSelection();
    };

    const refreshHover = () => {
      if (!hoverInspection) return;
      hoverFrame ??= requestAnimationFrame(() => {
        hoverFrame = null;

        if (hoverInspection) {
          showThemeInspectorHover(hoverInspection, getThemeEditorRoleLabel(hoverInspection.role));
        }
      });
    };

    const clearHoverOnScroll = () => clearHover();

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("click", blockInspectedClick, true);
    document.addEventListener("keydown", cancelInspection, true);
    window.addEventListener("resize", refreshHover);
    window.addEventListener("scroll", clearHoverOnScroll, true);

    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", blockInspectedClick, true);
      document.removeEventListener("keydown", cancelInspection, true);
      window.removeEventListener("resize", refreshHover);
      window.removeEventListener("scroll", clearHoverOnScroll, true);
      clearHoverTimer();

      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
      clearThemeInspectorHover();
    };
  }, [clearInspectorSelection, isInspecting, open, selectThemeRole]);

  return {
    isInspecting,
    setIsInspecting,
    selectedRole,
    setSelectedRole,
    usageCount,
    selectThemeRole,
    toggleThemeRole,
    clearInspectorSelection,
  };
}
