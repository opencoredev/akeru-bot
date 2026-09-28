import { threadSilentRun } from "@t3tools/client-runtime/silent-run";
import { useMobileI18n } from "../../lib/i18n";
import {
  NativeStackScreenOptions,
  type AppNativeStackNavigationOptions,
} from "../../native/StackHeader";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import * as Option from "effect/Option";
import { latestTurnFailure } from "@t3tools/client-runtime/provider-availability";
import {
  EnvironmentId,
  PLACEHOLDER_THREAD_TITLE,
  ThreadId,
  type BotAvatar,
} from "@t3tools/contracts";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWorkspaceState } from "../../state/workspace";

import { AppText } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { BotAvatarView, seededBlobAvatar } from "../../components/BotAvatarView";
import { GroupAvatarStack } from "../../components/GroupAvatarStack";
import { providerBotName } from "./thread-list-v2-items";
import { resolveThreadIdentity } from "./threadIdentity";
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
import { useSelectedThreadDetailState } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { ThreadDetailScreen } from "./ThreadDetailScreen";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomValue } from "@effect/atom-react";
import { environmentBotsAtom, environmentGroupsAtom } from "../../state/bots";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { threadEnvironment } from "../../state/threads";
import { projectThreadContentPresentation } from "./threadContentPresentation";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

type NativeHeaderItems = ReadonlyArray<Record<string, unknown>>;

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function OpeningThreadLoadingScreen() {
  const { t } = useMobileI18n();
  return <LoadingScreen message={t("Opening chat…")} messagePlacement="above-spinner" />;
}

type ThreadRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function ThreadUnavailableScreen() {
  const { t } = useMobileI18n();
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
        title={t("Chat unavailable")}
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
  const { t } = useMobileI18n();
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
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
  const silentRun = useMemo(
    () =>
      selectedThread?.latestTurn?.completedAt
        ? null
        : threadSilentRun(
            selectedThreadDetail?.activities ?? [],
            selectedThread?.latestTurn?.turnId,
          ),
    [selectedThread?.latestTurn, selectedThreadDetail?.activities],
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
  const environmentGroups = useAtomValue(
    environmentId
      ? environmentGroupsAtom(environmentId)
      : environmentGroupsAtom(EnvironmentId.make("")),
  );
  const botsById = useMemo(() => {
    const map = new Map<string, (typeof environmentBots)[number]>();
    for (const bot of environmentBots) map.set(bot.id, bot);
    return map;
  }, [environmentBots]);
  const threadId = firstRouteParam(params.threadId);
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
          }
        : null,
    [composer.modelSelection, composer.runtimeMode, selectedThread],
  );

  /* ─── Native header theming ──────────────────────────────────────── */
  const usesNativeHeaderGlass = NATIVE_LIQUID_GLASS_SUPPORTED;
  // Group chats take the group's name and member stack; direct bot chats the
  // bot, plain chats the provider identity — the same rule as the roster row.
  const headerProviderDriver =
    routeEnvironmentRuntime?.serverConfig?.providers.find(
      (candidate) =>
        candidate.instanceId ===
        (selectedThread?.session?.providerInstanceId ?? selectedThread?.modelSelection.instanceId),
    )?.driver ?? null;
  const headerIdentity = selectedThread
    ? resolveThreadIdentity({
        thread: selectedThread,
        bots: environmentBots,
        groups: environmentGroups,
        providerDriver: headerProviderDriver,
        providerName: providerBotName,
      })
    : null;
  const headerBotName = headerIdentity?.title ?? "Bot";
  // A group keeps its name in the title; its chat title stays in the subtitle.
  const headerTitle =
    !usesNativeHeaderGlass &&
    selectedThread !== null &&
    (selectedThread.groupId ?? null) === null &&
    selectedThread.title !== PLACEHOLDER_THREAD_TITLE
      ? selectedThread.title
      : headerBotName;
  const headerAvatarSeed = headerIdentity?.avatarSeed ?? headerProviderDriver ?? headerBotName;
  const headerSubtitle = [
    selectedThread !== null && selectedThread.title !== PLACEHOLDER_THREAD_TITLE
      ? selectedThread.title
      : null,
    selectedThreadProject?.title ?? null,
    selectedEnvironmentConnection?.environmentLabel ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  const handleReconnectEnvironment = useCallback(() => {
    if (!environmentId) {
      return;
    }
    onReconnectEnvironment(environmentId);
  }, [environmentId, onReconnectEnvironment]);

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


  const splitLeftHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      {
        // Match Mail's split-view detail toolbar: the first detail action sits
        // inside the content pane, not flush against the sidebar divider.
        spacing: 18,
        type: "spacing" as const,
      },
      withNativeGlassHeaderItem({
        accessibilityLabel: panes.primarySidebarVisible
          ? t("Maximize content")
          : t("Show chat sidebar"),
        icon: {
          name: panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left",
          type: "sfSymbol" as const,
        },
        identifier: "thread-left-sidebar",
        onPress: togglePrimarySidebar,
        type: "button" as const,
      }),
      withNativeGlassHeaderItem({
        accessibilityLabel: t("New chat"),
        icon: { name: "square.and.pencil", type: "sfSymbol" as const },
        identifier: "thread-left-new-task",
        onPress: () => navigation.navigate("NewTaskSheet", { screen: "NewTask" }),
        type: "button" as const,
      }),
    ],
    [panes.primarySidebarVisible, navigation, togglePrimarySidebar, t],
  );

  // Deep links / cold starts land with Thread as the ONLY route, where the
  // native back button does not render. Provide an explicit Home escape for
  // that case; when history exists the native back button is used instead.
  const canGoBack = navigation.canGoBack();
  const compactHomeHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      withNativeGlassHeaderItem({
        accessibilityLabel: t("Go to bots list"),
        icon: { name: "list.bullet", type: "sfSymbol" as const },
        identifier: "thread-left-home",
        onPress: () => navigation.dispatch(StackActions.replace("Home")),
        type: "button" as const,
      }),
    ],
    [navigation, t],
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

      unstable_headerSubtitle: usesNativeHeaderGlass ? headerSubtitle : undefined,
    }),
    [
      canGoBack,
      compactHomeHeaderItems,
      headerTitle,
      headerSubtitle,
      layout.usesSplitView,
      splitLeftHeaderItems,
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

  return (
    <>
      <NativeStackScreenOptions options={stackScreenOptions} />

      {Platform.OS === "android" ? (
        <ThreadBotHeader
          avatarSeed={headerAvatarSeed}
          botAvatar={headerIdentity?.isGroup ? null : (headerIdentity?.bots[0]?.avatar ?? null)}
          botName={headerBotName}
          headerIdentity={headerIdentity}
          subtitle={headerSubtitle}
          onBack={
            layout.usesSplitView
              ? undefined
              : () =>
                  canGoBack
                    ? navigation.goBack()
                    : navigation.dispatch(StackActions.replace("Home"))
          }
        />
      ) : null}

      <View className="flex-1 bg-screen">
        <ThreadDetailScreen
          selectedThread={selectedThreadWithDraftSettings ?? selectedThread}
          contentPresentation={contentPresentation}
          screenTone={connectionTone(routeConnectionState)}
          connectionError={routeConnectionError}
          environmentLabel={selectedEnvironmentConnection?.environmentLabel ?? null}
          selectedThreadFeed={composer.selectedThreadFeed}
          botsById={botsById}
          waitingOnChildren={composer.selectedThreadWaitingOnChildren}
          activeWorkStartedAt={composer.activeWorkStartedAt}
          silentRun={silentRun}
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
          onRespondToApproval={requests.onRespondToApproval}
          onSelectUserInputOption={requests.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={requests.onChangeUserInputCustomAnswer}
          onSubmitUserInput={requests.onSubmitUserInput}
        />
      </View>
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
  readonly headerIdentity: ReturnType<typeof resolveThreadIdentity> | null;
  readonly subtitle: string;
  readonly onBack?: (() => void) | undefined;
}) {
  const insets = useSafeAreaInsets();
  const foregroundColor = useThemeColor("--color-foreground");
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
            {props.headerIdentity?.isGroup ? (
              <GroupAvatarStack
                bots={props.headerIdentity.bots}
                seed={props.avatarSeed}
                size={26}
              />
            ) : (
              <BotAvatarView
                avatar={props.botAvatar ?? seededBlobAvatar(props.avatarSeed)}
                size={26}
              />
            )}
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
        {/* Balances the back circle so the bot pill stays centered. */}
        {props.onBack ? <View className="size-11" /> : null}
      </View>
    </View>
  );
}
