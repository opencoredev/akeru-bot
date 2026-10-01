import { useFocusEffect } from "@react-navigation/native";
import { NavigationContext, NavigationRouteContext } from "@react-navigation/native";
import { createContext, use, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  deriveFileInspectorPaneLayout,
  deriveLayout,
  deriveWorkspacePaneLayout,
  type FileInspectorPaneLayout,
  type Layout,
  type WorkspaceAuxiliaryPaneRole,
  type WorkspacePaneLayout,
} from "../../lib/layout";

interface AdaptiveWorkspaceContextValue {
  readonly layout: Layout;
  readonly panes: WorkspacePaneLayout;
  readonly fileInspector: FileInspectorPaneLayout;
  readonly primarySidebarSearchQuery: string;
  readonly activateAuxiliaryPaneRole: (role: WorkspaceAuxiliaryPaneRole) => () => void;
  /**
   * Route screens hand their inspector pane content to the workspace so it
   * renders BESIDE the navigator (outside the native stack header) instead of
   * inside the route. Returns a deactivate callback: the pane animates closed
   * (content kept mounted for the exit transition) unless a newer
   * registration already took over — stale deactivates never clobber it.
   * Prefer useRegisterWorkspaceInspector over calling this directly.
   */
  readonly registerWorkspaceInspector: (render: () => ReactNode) => () => void;
  readonly setPrimarySidebarSearchQuery: (query: string) => void;
  readonly showAuxiliaryPane: (role: WorkspaceAuxiliaryPaneRole) => void;
  readonly toggleAuxiliaryPane: () => void;
  readonly togglePrimarySidebar: () => void;
  readonly setAuxiliaryPaneWidth: (width: number) => void;
}

const compactLayout = deriveLayout({ width: 0, height: 0 });
const compactPanes = deriveWorkspacePaneLayout({
  layout: compactLayout,
  viewportWidth: 0,
  primarySidebarPreferredVisible: true,
  auxiliaryPanePreferredVisible: true,
});
const compactFileInspector = deriveFileInspectorPaneLayout({
  layout: compactLayout,
  viewportWidth: 0,
});
export const AdaptiveWorkspaceContext = createContext<AdaptiveWorkspaceContextValue>({
  layout: compactLayout,
  panes: compactPanes,
  fileInspector: compactFileInspector,
  primarySidebarSearchQuery: "",
  activateAuxiliaryPaneRole: () => () => undefined,
  registerWorkspaceInspector: () => () => undefined,
  setPrimarySidebarSearchQuery: () => undefined,
  showAuxiliaryPane: () => undefined,
  toggleAuxiliaryPane: () => undefined,
  togglePrimarySidebar: () => undefined,
  setAuxiliaryPaneWidth: () => undefined,
});

export function useAdaptiveWorkspaceLayout(): AdaptiveWorkspaceContextValue {
  return use(AdaptiveWorkspaceContext);
}

export function useAdaptiveWorkspacePaneRole(role: WorkspaceAuxiliaryPaneRole) {
  const { activateAuxiliaryPaneRole } = useAdaptiveWorkspaceLayout();

  useFocusEffect(
    useCallback(() => activateAuxiliaryPaneRole(role), [activateAuxiliaryPaneRole, role]),
  );
}

/**
 * Register this screen's inspector pane content with the workspace column.
 *
 * The column renders BESIDE the navigator — outside any screen — so the
 * registering screen's navigation and route contexts are captured here and
 * re-provided around the portal content. Without them, useNavigation/useRoute
 * inside the pane (e.g. GitOverviewSheet via useThreadSelection) throw
 * "Couldn't find a route object".
 *
 * Registration is FOCUS-scoped, driven by navigation events rather than the
 * screen's own render cycle: react-native-screens freezes blurred screens, so
 * a cleanup that depends on the blurred subtree re-rendering never runs and
 * would leak the pane into the next route. Blur deactivates the pane (it
 * animates closed, or is replaced seamlessly when the next route registers in
 * the same commit); focus re-registers it.
 */
export function useRegisterWorkspaceInspector(render: (() => ReactNode) | undefined) {
  const { registerWorkspaceInspector } = useAdaptiveWorkspaceLayout();
  // Raw context values (not the useNavigation/useRoute wrappers) so the
  // portal re-provides exactly what this screen sees.
  const navigation = use(NavigationContext);
  const route = use(NavigationRouteContext);

  const wrappedRender = useMemo(() => {
    if (render === undefined) {
      return undefined;
    }
    return () => (
      <NavigationContext.Provider value={navigation}>
        <NavigationRouteContext.Provider value={route}>{render()}</NavigationRouteContext.Provider>
      </NavigationContext.Provider>
    );
  }, [navigation, render, route]);

  const wrappedRenderRef = useRef(wrappedRender);
  wrappedRenderRef.current = wrappedRender;
  const focusedRef = useRef(false);
  const deactivateRef = useRef<(() => void) | null>(null);

  const syncRegistration = useCallback(() => {
    if (!focusedRef.current || wrappedRenderRef.current === undefined) {
      deactivateRef.current?.();
      return;
    }
    deactivateRef.current = registerWorkspaceInspector(wrappedRenderRef.current);
  }, [registerWorkspaceInspector]);

  // Focus lifecycle. Blur/focus events fire even when the blurred subtree is
  // frozen (events are navigation-driven, renders are not).
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      syncRegistration();
      return () => {
        focusedRef.current = false;
        syncRegistration();
      };
    }, [syncRegistration]),
  );

  // Content changes while focused re-register in place.
  useEffect(() => {
    if (focusedRef.current) {
      syncRegistration();
    }
  }, [syncRegistration, wrappedRender]);

  // Unmount: hand the pane back (owner-guarded, so a route that already
  // took over is unaffected).
  useEffect(
    () => () => {
      deactivateRef.current?.();
      deactivateRef.current = null;
    },
    [],
  );
}
