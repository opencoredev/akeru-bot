import {
  NativeStackScreenOptions,
  type AppNativeStackNavigationOptions,
} from "../../native/StackHeader";
import {
  StackActions,
  useFocusEffect,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Option from "effect/Option";
import { latestTurnFailure } from "@t3tools/client-runtime/provider-availability";
import {
  EnvironmentId,
  PLACEHOLDER_THREAD_TITLE,
  ThreadId,
  type BotAvatar,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWorkspaceState } from "../../state/workspace";
import { useEnvironmentQuery } from "../../state/query";
import { dismissGitActionResult, useGitActionProgress } from "../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../state/vcs";

import { AppText } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { BotAvatarView, seededBlobAvatar } from "../../components/BotAvatarView";
import { providerBotName } from "./thread-list-v2-items";
import { ControlPillMenu } from "../../components/ControlPill";
import {
  buildThreadWorkspaceActions,
  runThreadWorkspaceAction,
  type ThreadWorkspaceAction,
} from "./threadWorkspaceActions";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThemeColor } from "../../lib/useThemeColor";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { connectionTone } from "../connection/connectionTone";

import {
  useRemoteConnections,
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
} from "../../state/use-remote-environment-registry";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { useSelectedThreadDetailState } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { GitActionProgressOverlay } from "./GitActionProgressOverlay";
import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  resolveProjectScriptTerminalId,
} from "../terminal/terminalMenu";
import {
  resolvePreferredThreadWorktreePath,
  stagePendingTerminalLaunch,
} from "../terminal/terminalLaunchContext";
import { terminalDebugLog } from "../terminal/terminalDebugLog";
import { ThreadDetailScreen } from "./ThreadDetailScreen";
import {
  ThreadGitControls,
  useThreadGitCenterHeaderItems,
  useThreadGitRightHeaderItems,
} from "./ThreadGitControls";
import { GitOverviewSheet } from "./git/GitOverviewSheet";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomValue } from "@effect/atom-react";
import { environmentBotsAtom } from "../../state/bots";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { threadEnvironment } from "../../state/threads";
import { projectThreadContentPresentation } from "./threadContentPresentation";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { ThreadFileNavigatorPane } from "../files/thread-file-navigator-pane";
import {
  ThreadInspectorContentStack,
  type ThreadInspectorMode,
} from "./thread-inspector-content-stack";

interface ThreadInspectorSelection {
  readonly routeThreadIdentity: string | null;
  readonly mode: ThreadInspectorMode;
}

type NativeHeaderItems = ReadonlyArray<Record<string, unknown>>;

function InspectorPaneRoleActivation() {
  useAdaptiveWorkspacePaneRole("inspector");
  return null;
}

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function OpeningThreadLoadingScreen() {
  return <LoadingScreen message="Opening chat…" messagePlacement="above-spinner" />;
}

type ThreadRouteScreenRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

interface ThreadRouteScreenProps extends ThreadRouteScreenRouteProps {
  readonly onReturnToThread?: () => void;
  readonly renderInspector?: (headerInset: number) => ReactNode;
}

function ThreadUnavailableScreen() {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      className="bg-screen flex-1"
    >
      <EmptyState
        title="Chat unavailable"
        detail="This chat is not available in the current mobile snapshot."
      />
    </ScrollView>
  );
}

export function ThreadRouteScreen(props: ThreadRouteScreenProps) {
  const { state: workspaceState } = useWorkspaceState();
  const { connectionState } = useRemoteConnectionStatus();
  const { selectedThread } = useThreadSelection();
  const params = props.route.params;
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const threadIdRaw = firstRouteParam(params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeThreadKey =
    environmentId !== null && threadIdRaw !== null
      ? scopedThreadKey(environmentId, ThreadId.make(threadIdRaw))
      : null;
  const selectedThreadKey =
    selectedThread === null
      ? null
      : scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const selectedThreadDetailState = useSelectedThreadDetailState();

  if (environmentId === null || threadIdRaw === null) {
    return <OpeningThreadLoadingScreen />;
  }

  // Render the full thread chrome (header, feed, composer) as soon as the
  // thread SHELL is known — no blocking on message detail. The feed shows a
  // loading placeholder while messages fetch, and the composer's connection
  // pill reports connecting/reconnecting/syncing status.
  if (selectedThread !== null && selectedThreadKey === routeThreadKey) {
    return <ThreadRouteContent {...props} selectedThreadDetailState={selectedThreadDetailState} />;
  }

  const stillHydrating =
    workspaceState.isLoadingConnections ||
    routeConnectionState === "connecting" ||
    routeConnectionState === "reconnecting";

  if (stillHydrating) {
    return <OpeningThreadLoadingScreen />;
  }

  return <ThreadUnavailableScreen />;
}

function ThreadRouteContent(
  props: ThreadRouteScreenProps & {
    readonly selectedThreadDetailState: ReturnType<typeof useSelectedThreadDetailState>;
  },
) {
  const {
    fileInspector,
    layout,
    panes,
    showAuxiliaryPane,
    toggleAuxiliaryPane,
    togglePrimarySidebar,
  } = useAdaptiveWorkspaceLayout();
  const { connectionState } = useRemoteConnectionStatus();
  const { onReconnectEnvironment } = useRemoteConnections();
  const { selectedThread, selectedThreadProject, selectedEnvironmentConnection } =
    useThreadSelection();
  const selectedThreadDetailState = props.selectedThreadDetailState;
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  // The session keeps only the raw error text, so the failure category comes
  // from the turn or the start-failed activity when the session lacks it.
  const resumeFailureUnavailability = useMemo(
    () =>
      selectedThread?.latestTurn?.unavailability ??
      selectedThread?.session?.unavailability ??
      latestTurnFailure(
        selectedThreadDetail?.activities ?? [],
        selectedThreadDetail?.messages.findLast((message) => message.role === "user")?.createdAt,
      )?.unavailability ??
      null,
    [selectedThread, selectedThreadDetail],
  );
  // "Load earlier turns" header state for windowed (paginated) thread loads.
  const loadEarlierTurns = useMemo(() => {
    if (selectedThread === null || !threadHasOlderTurns(selectedThreadDetailState)) {
      return null;
    }
    return {
      loading:
        selectedThreadDetailState.page._tag === "Some" &&
        selectedThreadDetailState.page.value.loadingOlder,
      onLoadEarlier: () => {
        requestOlderThreadTurns(selectedThread.environmentId, selectedThread.id);
      },
    };
  }, [selectedThread, selectedThreadDetailState]);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const composer = useThreadComposerState();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const requests = useSelectedThreadRequests();
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, "thread interrupt");
  const resumeThreadTurn = useAtomCommand(threadEnvironment.resumeTurn, "thread resume");
  const [resumingThread, setResumingThread] = useState(false);
  const navigation = useNavigation();
  const params = props.route.params;
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const environmentBots = useAtomValue(
    environmentId
      ? environmentBotsAtom(environmentId)
      : environmentBotsAtom(EnvironmentId.make("")),
  );
  const threadId = firstRouteParam(params.threadId);
  const routeThreadIdentity =
    environmentIdRaw !== null && threadId !== null ? `${environmentIdRaw}:${threadId}` : null;
  const [inspectorSelection, setInspectorSelection] = useState<ThreadInspectorSelection | null>(
    () => (props.renderInspector ? { routeThreadIdentity, mode: "route" } : null),
  );
  const inspectorMode = (() => {
    if (inspectorSelection?.routeThreadIdentity === routeThreadIdentity) {
      if (inspectorSelection.mode === "files" && selectedThreadCwd === null) {
        return null;
      }
      return inspectorSelection.mode;
    }
    return null;
  })();
  useEffect(() => {
    if (
      fileInspector.supported &&
      selectedThreadCwd === null &&
      inspectorMode === null &&
      panes.auxiliaryPaneVisible
    ) {
      toggleAuxiliaryPane();
    }
  }, [
    fileInspector.supported,
    inspectorMode,
    panes.auxiliaryPaneVisible,
    selectedThreadCwd,
    toggleAuxiliaryPane,
  ]);

  useEffect(() => {
    setInspectorSelection((current) => {
      if (props.renderInspector === undefined) {
        if (current === null || current.mode === "route") {
          return null;
        }
        return { ...current, routeThreadIdentity };
      }

      if (current === null || current.mode === "route") {
        return { routeThreadIdentity, mode: "route" };
      }

      return { ...current, routeThreadIdentity };
    });
  }, [props.renderInspector, routeThreadIdentity]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        if (props.renderInspector === undefined) {
          // Inspectors are contextual to this chat destination. Clear the
          // hidden chat copy after a native push so returning from Files,
          // Review, or Terminal cannot reserve an empty trailing pane.
          setInspectorSelection(null);
        }
      };
    }, [props.renderInspector]),
  );
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeConnectionError = routeEnvironmentRuntime?.connectionError ?? null;
  const selectedThreadWithDraftSettings = useMemo(
    () =>
      selectedThread
        ? {
            ...selectedThread,
            modelSelection: composer.modelSelection ?? selectedThread.modelSelection,
            runtimeMode: composer.runtimeMode ?? selectedThread.runtimeMode,
            interactionMode: composer.interactionMode ?? selectedThread.interactionMode,
          }
        : null,
    [composer.interactionMode, composer.modelSelection, composer.runtimeMode, selectedThread],
  );

  /* ─── Native header theming ──────────────────────────────────────── */
  const usesNativeHeaderGlass = NATIVE_LIQUID_GLASS_SUPPORTED;
  const threadBot = selectedThread?.botId
    ? (environmentBots.find((bot) => bot.id === selectedThread.botId) ?? null)
    : null;
  // Threads without a configured bot still read as a named teammate: the
  // provider identity supplies the name and avatar seed, and the chat title
  // demotes to the subtitle.
  const headerProviderDriver =
    routeEnvironmentRuntime?.serverConfig?.providers.find(
      (candidate) =>
        candidate.instanceId ===
        (selectedThread?.session?.providerInstanceId ?? selectedThread?.modelSelection.instanceId),
    )?.driver ?? null;
  const headerBotName = threadBot?.name ?? providerBotName(headerProviderDriver) ?? "Bot";
  const headerTitle =
    !usesNativeHeaderGlass &&
    selectedThread !== null &&
    selectedThread.title !== PLACEHOLDER_THREAD_TITLE
      ? selectedThread.title
      : headerBotName;
  const headerAvatarSeed = headerProviderDriver ?? headerBotName;
  const headerSubtitle = [
    selectedThread !== null && selectedThread.title !== PLACEHOLDER_THREAD_TITLE
      ? selectedThread.title
      : null,
    selectedThreadProject?.title ?? null,
    selectedEnvironmentConnection?.environmentLabel ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  /* ─── Git status for native header trigger ───────────────────────── */
  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const terminalMenuSessions = useMemo(
    () =>
      buildTerminalMenuSessions({
        knownSessions: knownTerminalSessions,
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
      }),
    [knownTerminalSessions, selectedThreadProject?.workspaceRoot],
  );
  const selectedThreadDetailWorktreePath = selectedThreadDetail?.worktreePath ?? null;
  const handleReconnectEnvironment = useCallback(() => {
    if (!environmentId) {
      return;
    }
    onReconnectEnvironment(environmentId);
  }, [environmentId, onReconnectEnvironment]);

  /* ─── Git action progress (for overlay banner) ──────────────────── */
  const gitActionProgressTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    [selectedThread?.environmentId, selectedThreadCwd],
  );
  const gitActionProgress = useGitActionProgress(gitActionProgressTarget);

  const handleOpenGitInspector = useCallback(() => {
    if (!fileInspector.supported) {
      if (selectedThread === null) {
        return;
      }
      navigation.navigate("GitOverview", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    setInspectorSelection({ routeThreadIdentity, mode: "git" });
    showAuxiliaryPane("inspector");
  }, [fileInspector.supported, navigation, routeThreadIdentity, selectedThread, showAuxiliaryPane]);
  const handleOpenFilesInspector = useCallback(() => {
    if (selectedThread === null || selectedThreadCwd === null) {
      return;
    }
    if (!fileInspector.supported) {
      navigation.navigate("ThreadFiles", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    setInspectorSelection({
      routeThreadIdentity,
      mode: props.renderInspector === undefined ? "files" : "route",
    });
    showAuxiliaryPane("inspector");
  }, [
    fileInspector.supported,
    navigation,
    props.renderInspector,
    routeThreadIdentity,
    selectedThread,
    selectedThreadCwd,
    showAuxiliaryPane,
  ]);
  const inspectorToggleActionRef = useRef({
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  });
  inspectorToggleActionRef.current = {
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  };
  const handleToggleInspector = useCallback(() => {
    const action = inspectorToggleActionRef.current;
    if (action.inspectorMode === null) {
      action.openFilesInspector();
      return;
    }
    action.toggleAuxiliaryPane();
  }, []);
  const handleSelectInspectorFile = useCallback(
    (path: string) => {
      if (selectedThread === null) {
        return;
      }
      const params = {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        path: path.split("/").filter((segment) => segment.length > 0),
      };
      if (fileInspector.supported) {
        navigation.navigate("ThreadFile", params);
        return;
      }
      navigation.navigate("ThreadFile", params);
    },
    [fileInspector.supported, navigation, selectedThread],
  );
  // The workspace inspector column spans the full window height. On iOS the
  // panes bring their own nested native headers (which underlap the status
  // bar); elsewhere the pane content pads itself below the top inset.
  const safeAreaInsets = useSafeAreaInsets();
  const inspectorHeaderInset = Platform.OS === "ios" ? 0 : safeAreaInsets.top;
  const GitInspector = useCallback(
    () => (
      <GitOverviewSheet
        headerInset={inspectorHeaderInset}
        presentation="inspector"
        route={{ params: props.route.params }}
      />
    ),
    [inspectorHeaderInset, props.route.params],
  );
  const FilesInspector = useCallback(
    () =>
      selectedThread !== null && selectedThreadCwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={selectedThreadCwd}
          environmentId={selectedThread.environmentId}
          headerInset={inspectorHeaderInset}
          projectName={selectedThreadProject?.title ?? "Files"}
          selectedPath={null}
          onSelectFile={handleSelectInspectorFile}
        />
      ) : null,
    [
      handleSelectInspectorFile,
      inspectorHeaderInset,
      selectedThread,
      selectedThreadCwd,
      selectedThreadProject?.title,
    ],
  );
  const RouteInspector = useCallback(
    () => props.renderInspector?.(inspectorHeaderInset),
    [inspectorHeaderInset, props.renderInspector],
  );
  const renderInspectorStack = useCallback(
    () =>
      inspectorMode === null ? null : (
        <ThreadInspectorContentStack
          Files={FilesInspector}
          Git={GitInspector}
          mode={inspectorMode}
          Route={props.renderInspector ? RouteInspector : undefined}
        />
      ),
    [FilesInspector, GitInspector, RouteInspector, inspectorMode, props.renderInspector],
  );
  const activeInspectorRenderer = inspectorMode === null ? undefined : renderInspectorStack;
  // Hand the inspector to the workspace so it renders beside the navigator,
  // outside this screen's native header — the terminal/git/files toolbar
  // stays anchored to the chat pane instead of floating above the inspector.
  useRegisterWorkspaceInspector(activeInspectorRenderer);

  const handleOpenConnectionEditor = useCallback(() => {
    void navigation.navigate("Connections");
  }, [navigation]);
  const handleStopThread = useCallback(() => {
    if (
      !selectedThread ||
      (selectedThread.session?.status !== "running" &&
        selectedThread.session?.status !== "starting")
    ) {
      return;
    }
    return interruptThreadTurn({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        ...(selectedThread.session.activeTurnId
          ? { turnId: selectedThread.session.activeTurnId }
          : {}),
      },
    });
  }, [interruptThreadTurn, selectedThread]);
  const handleResumeThread = useCallback(() => {
    if (!selectedThread || resumingThread) return;
    setResumingThread(true);
    void resumeThreadTurn({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id },
    }).finally(() => setResumingThread(false));
  }, [resumeThreadTurn, resumingThread, selectedThread]);

  const handleOpenTerminal = useCallback(
    (nextTerminalId?: string | null) => {
      terminalDebugLog("terminal-menu:open-existing", {
        terminalId: nextTerminalId ?? null,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        return;
      }

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        ...(nextTerminalId ? { terminalId: nextTerminalId } : {}),
      });
    },
    [navigation, selectedThread, selectedThreadProject?.workspaceRoot],
  );

  const handleOpenNewTerminal = useCallback(() => {
    terminalDebugLog("terminal-menu:open-new", {
      hasThread: Boolean(selectedThread),
      hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });

    if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
      return;
    }

    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });
    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      terminalId: nextId,
    });
  }, [navigation, selectedThread, selectedThreadProject?.workspaceRoot, terminalMenuSessions]);

  const handleRunProjectScript = useCallback(
    async (script: ProjectScript) => {
      terminalDebugLog("project-script:press", {
        scriptId: script.id,
        command: script.command,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        terminalDebugLog("project-script:abort", {
          scriptId: script.id,
          reason: "no-thread-or-workspace",
        });
        return;
      }

      const targetTerminalId = resolveProjectScriptTerminalId({
        existingTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
        hasRunningTerminal: terminalMenuSessions.some(
          (session) => session.status === "running" || session.status === "starting",
        ),
      });
      const preferredWorktreePath = resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread.worktreePath ?? null,
        threadDetailWorktreePath: selectedThreadDetailWorktreePath,
      });
      const cwd = projectScriptCwd({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      const env = projectScriptRuntimeEnv({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      stagePendingTerminalLaunch({
        target: {
          environmentId: selectedThread.environmentId,
          threadId: selectedThread.id,
          terminalId: targetTerminalId,
        },
        launch: {
          cwd,
          worktreePath: preferredWorktreePath,
          env,
          initialInput: `${script.command}\r`,
        },
      });
      terminalDebugLog("project-script:staged", {
        scriptId: script.id,
        terminalId: targetTerminalId,
        cwd,
        worktreePath: preferredWorktreePath,
      });

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: targetTerminalId,
      });
    },
    [
      navigation,
      selectedThread,
      selectedThreadDetailWorktreePath,
      selectedThreadProject,
      terminalMenuSessions,
    ],
  );
  const threadGitControlProps = {
    environmentId: environmentIdRaw ?? "",
    threadId: threadId ?? "",
    auxiliaryPaneControl:
      !layout.usesSplitView && fileInspector.supported && selectedThreadCwd !== null
        ? {
            accessibilityLabel: "Toggle inspector",
            onPress: handleToggleInspector,
          }
        : undefined,
    onOpenFilesInspector:
      fileInspector.supported && selectedThreadCwd !== null ? handleOpenFilesInspector : undefined,
    onOpenGitInspector: selectedThread !== null ? handleOpenGitInspector : undefined,
    currentBranch: selectedThread?.branch ?? null,
    gitStatus: gitStatus.data,
    gitOperationLabel: gitState.gitOperationLabel,
    canOpenTerminal: Boolean(selectedThreadProject?.workspaceRoot),
    canOpenFiles: Boolean(selectedThreadProject?.workspaceRoot),
    projectScripts: selectedThreadProject?.scripts ?? [],
    terminalSessions: terminalMenuSessions,
    showDirectFileControl: layout.usesSplitView,
    onOpenTerminal: handleOpenTerminal,
    onOpenNewTerminal: handleOpenNewTerminal,
    onRunProjectScript: handleRunProjectScript,
    onPull: gitActions.onPullSelectedThreadBranch,
    onRunAction: gitActions.onRunSelectedThreadGitAction,
  };
  const threadCenterHeaderItems = useThreadGitCenterHeaderItems(threadGitControlProps);
  const compactRightHeaderItems = useThreadGitRightHeaderItems(threadGitControlProps);
  // The bot header owns navigation and identity, so Android collects the
  // workspace tools behind one overflow control instead of a row of icons.
  const workspaceActions = useMemo(
    () =>
      buildThreadWorkspaceActions({
        canOpenFiles: fileInspector.supported && selectedThreadCwd !== null,
        canOpenTerminal: Boolean(selectedThreadProject?.workspaceRoot),
        canOpenGit: selectedThread !== null && selectedThreadCwd !== null,
        canToggleInspector:
          !layout.usesSplitView && fileInspector.supported && selectedThreadCwd !== null,
      }),
    [
      fileInspector.supported,
      layout.usesSplitView,
      selectedThreadCwd,
      selectedThread,
      selectedThreadProject?.workspaceRoot,
    ],
  );
  const handleWorkspaceAction = useCallback(
    (id: ThreadWorkspaceAction["id"]) => {
      runThreadWorkspaceAction(id, {
        openFiles: handleOpenFilesInspector,
        openTerminal: () => handleOpenTerminal(null),
        openGit: handleOpenGitInspector,
        toggleInspector: handleToggleInspector,
      });
    },
    [handleOpenFilesInspector, handleOpenGitInspector, handleOpenTerminal, handleToggleInspector],
  );
  const splitLeftHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      {
        // Match Mail's split-view detail toolbar: the first detail action sits
        // inside the content pane, not flush against the sidebar divider.
        spacing: 18,
        type: "spacing" as const,
      },
      ...(props.onReturnToThread
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Return to chat",
              icon: { name: "chevron.left", type: "sfSymbol" as const },
              identifier: "thread-left-return",
              onPress: props.onReturnToThread,
              type: "button" as const,
            }),
          ]
        : []),
      withNativeGlassHeaderItem({
        accessibilityLabel: panes.primarySidebarVisible ? "Maximize content" : "Show chat sidebar",
        icon: {
          name: panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left",
          type: "sfSymbol" as const,
        },
        identifier: "thread-left-sidebar",
        onPress: togglePrimarySidebar,
        type: "button" as const,
      }),
      withNativeGlassHeaderItem({
        accessibilityLabel: "New chat",
        icon: { name: "square.and.pencil", type: "sfSymbol" as const },
        identifier: "thread-left-new-task",
        onPress: () => navigation.navigate("NewTaskSheet", { screen: "NewTask" }),
        type: "button" as const,
      }),
    ],
    [panes.primarySidebarVisible, props.onReturnToThread, navigation, togglePrimarySidebar],
  );
  // Deep links / cold starts land with Thread as the ONLY route, where the
  // native back button does not render. Provide an explicit Home escape for
  // that case; when history exists the native back button is used instead.
  const canGoBack = navigation.canGoBack();
  const compactHomeHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      withNativeGlassHeaderItem({
        accessibilityLabel: "Go to bots list",
        icon: { name: "list.bullet", type: "sfSymbol" as const },
        identifier: "thread-left-home",
        onPress: () => navigation.dispatch(StackActions.replace("Home")),
        type: "button" as const,
      }),
    ],
    [navigation],
  );

  // Memoized so a composer keystroke does not re-sign the whole header config.
  const stackScreenOptions = useMemo<AppNativeStackNavigationOptions>(
    () => ({
      // Android draws its own in-flow header (AndroidScreenHeader below);
      // the native stack header stays iOS-only.
      headerShown: Platform.OS !== "android",
      headerTitle,
      headerTitleStyle: usesNativeHeaderGlass
        ? {
            fontSize: 17,
            fontWeight: "800",
          }
        : undefined,
      title: headerTitle,
      headerBackVisible: !layout.usesSplitView,
      // Compact uses the NATIVE back button when a previous route exists;
      // deep links / cold starts get an explicit Home button instead.
      // Split view always uses its custom left items.
      unstable_headerLeftItems:
        Platform.OS === "ios"
          ? layout.usesSplitView
            ? () => splitLeftHeaderItems
            : canGoBack
              ? undefined
              : () => compactHomeHeaderItems
          : undefined,
      // The header title identifies the chat on older iOS and the bot on native glass; the workspace tools
      // stay on the RIGHT, where split view keeps the richer center-item
      // ordering (no breadcrumbs occupy that space yet).
      unstable_headerRightItems:
        Platform.OS === "ios"
          ? () => (layout.usesSplitView ? threadCenterHeaderItems : compactRightHeaderItems)
          : undefined,
      unstable_headerSubtitle: usesNativeHeaderGlass ? headerSubtitle : undefined,
    }),
    [
      canGoBack,
      compactHomeHeaderItems,
      compactRightHeaderItems,
      headerTitle,
      headerSubtitle,
      layout.usesSplitView,
      splitLeftHeaderItems,
      threadCenterHeaderItems,
      usesNativeHeaderGlass,
    ],
  );

  if (!environmentId || !threadId) {
    return <OpeningThreadLoadingScreen />;
  }

  if (!selectedThread) {
    return <OpeningThreadLoadingScreen />;
  }

  const contentPresentation = projectThreadContentPresentation({
    hasDetail: selectedThreadDetail !== null,
    detailError: Option.getOrNull(selectedThreadDetailState.error),
    detailDeleted: selectedThreadDetailState.status === "deleted",
    connectionState: routeConnectionState,
  });
  const serverConfig = routeEnvironmentRuntime?.serverConfig ?? null;
  const renderThreadRouteBody = (showActionControls: boolean) => (
    <>
      <ThreadGitControls {...threadGitControlProps} showActionControls={showActionControls} />

      <GitActionProgressOverlay progress={gitActionProgress} onDismiss={dismissGitActionResult} />

      <View className="flex-1 bg-screen">
        <ThreadDetailScreen
          selectedThread={selectedThreadWithDraftSettings ?? selectedThread}
          contentPresentation={contentPresentation}
          screenTone={connectionTone(routeConnectionState)}
          connectionError={routeConnectionError}
          environmentLabel={selectedEnvironmentConnection?.environmentLabel ?? null}
          selectedThreadFeed={composer.selectedThreadFeed}
          activeWorkStartedAt={composer.activeWorkStartedAt}
          activePendingApproval={requests.activePendingApproval}
          respondingApprovalId={requests.respondingApprovalId}
          activePendingUserInput={requests.activePendingUserInput}
          activePendingUserInputDrafts={requests.activePendingUserInputDrafts}
          activePendingUserInputAnswers={requests.activePendingUserInputAnswers}
          respondingUserInputId={requests.respondingUserInputId}
          connectionStateLabel={routeConnectionState}
          threadSyncStatus={selectedThreadDetailState.status}
          loadEarlier={loadEarlierTurns}
          environmentId={selectedThread.environmentId}
          projectWorkspaceRoot={selectedThreadProject?.workspaceRoot ?? null}
          threadCwd={selectedThreadCwd}
          selectedThreadQueueCount={composer.selectedThreadQueueCount}
          layoutVariant={layout.variant}
          usesAutomaticContentInsets={usesNativeHeaderGlass}
          onOpenConnectionEditor={handleOpenConnectionEditor}
          onChangeDraftMessage={composer.onChangeDraftMessage}
          onPickDraftImages={composer.onPickDraftImages}
          onNativePasteImages={composer.onNativePasteImages}
          onRemoveDraftImage={composer.onRemoveDraftImage}
          serverConfig={serverConfig}
          onStopThread={handleStopThread}
          onResumeThread={handleResumeThread}
          canResumeThread={
            selectedThread.session?.status === "error" &&
            (selectedThread.latestTurn?.state === "error" ||
              selectedThread.latestTurn?.state === "interrupted" ||
              (selectedThread.latestTurn === null &&
                selectedThreadDetail?.messages.at(-1)?.role === "user"))
          }
          resumeFailureUnavailability={resumeFailureUnavailability}
          resumingThread={resumingThread}
          onSendMessage={composer.onSendMessage}
          onReconnectEnvironment={handleReconnectEnvironment}
          onUpdateThreadModelSelection={composer.onUpdateModelSelection}
          onUpdateThreadRuntimeMode={composer.onUpdateRuntimeMode}
          onUpdateThreadInteractionMode={composer.onUpdateInteractionMode}
          onRespondToApproval={requests.onRespondToApproval}
          onSelectUserInputOption={requests.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={requests.onChangeUserInputCustomAnswer}
          onSubmitUserInput={requests.onSubmitUserInput}
        />
      </View>
    </>
  );

  return (
    <>
      {activeInspectorRenderer ? <InspectorPaneRoleActivation /> : null}
      <NativeStackScreenOptions options={stackScreenOptions} />

      {Platform.OS === "android" ? (
        <ThreadBotHeader
          avatarSeed={headerAvatarSeed}
          botAvatar={threadBot?.avatar ?? null}
          botName={headerBotName}
          subtitle={headerSubtitle}
          onBack={
            layout.usesSplitView
              ? (props.onReturnToThread ?? undefined)
              : () =>
                  canGoBack
                    ? navigation.goBack()
                    : navigation.dispatch(StackActions.replace("Home"))
          }
          workspaceActions={workspaceActions}
          onWorkspaceAction={handleWorkspaceAction}
        />
      ) : null}

      {/* Android keeps its tools in the in-flow header overflow above, and
          split view uses the native center items, so the fallback toolbar is
          only for compact iOS without the native glass header. */}
      {renderThreadRouteBody(
        Platform.OS !== "android" && !layout.usesSplitView && !usesNativeHeaderGlass,
      )}
    </>
  );
}

/**
 * Roster-style chat header (Android): a back circle and a floating pill with
 * the bot's avatar and name, matching the web roster's chat chrome.
 */
function ThreadBotHeader(props: {
  readonly avatarSeed: string;
  readonly botAvatar: BotAvatar | null;
  readonly botName: string;
  readonly subtitle: string;
  readonly onBack?: (() => void) | undefined;
  readonly workspaceActions: ReadonlyArray<ThreadWorkspaceAction>;
  readonly onWorkspaceAction: (id: ThreadWorkspaceAction["id"]) => void;
}) {
  const insets = useSafeAreaInsets();
  const foregroundColor = useThemeColor("--color-foreground");
  const { onWorkspaceAction } = props;
  const handleWorkspaceMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      onWorkspaceAction(nativeEvent.event as ThreadWorkspaceAction["id"]);
    },
    [onWorkspaceAction],
  );
  return (
    <View className="bg-screen px-4 pb-2" style={{ paddingTop: Math.max(insets.top, 12) + 4 }}>
      <View className="flex-row items-center gap-3">
        {props.onBack ? (
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            className="size-11 items-center justify-center rounded-full bg-subtle"
            hitSlop={6}
            onPress={props.onBack}
          >
            <SymbolView
              name="chevron.left"
              size={20}
              tintColor={foregroundColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
        <View className="flex-1 flex-row justify-center">
          <View
            className="max-w-full flex-row items-center gap-2 rounded-full bg-card py-1.5 pl-2 pr-4"
            style={{
              elevation: 3,
              shadowColor: "#000000",
              shadowOffset: { height: 3, width: 0 },
              shadowOpacity: 0.08,
              shadowRadius: 8,
            }}
          >
            <BotAvatarView
              avatar={props.botAvatar ?? seededBlobAvatar(props.avatarSeed)}
              size={26}
            />
            <View className="min-w-0 shrink">
              <AppText className="text-[16px] font-t3-bold text-foreground" numberOfLines={1}>
                {props.botName}
              </AppText>
              {props.subtitle ? (
                <AppText className="text-xs text-foreground-muted" numberOfLines={1}>
                  {props.subtitle}
                </AppText>
              ) : null}
            </View>
          </View>
        </View>
        {props.workspaceActions.length > 0 ? (
          <ControlPillMenu
            actions={props.workspaceActions.map((action) => ({
              id: action.id,
              title: action.title,
              image: action.image,
            }))}
            onPressAction={handleWorkspaceMenuAction}
            title="Workspace"
          >
            <Pressable
              accessibilityHint="Opens files, terminal, git actions, and the inspector"
              accessibilityLabel="Workspace tools"
              accessibilityRole="button"
              className="size-11 items-center justify-center rounded-full bg-subtle"
              hitSlop={6}
            >
              <SymbolView name="ellipsis" size={20} tintColor={foregroundColor} type="monochrome" />
            </Pressable>
          </ControlPillMenu>
        ) : props.onBack ? (
          <View className="size-11" />
        ) : null}
      </View>
    </View>
  );
}
