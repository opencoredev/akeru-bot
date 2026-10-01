import { useMobileI18n } from "../../lib/i18n";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationThreadShell,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@akeru/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@akeru/shared/composerTrigger";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Image, Platform, Pressable, StyleSheet, View } from "react-native";
import ImageViewing from "react-native-image-viewing";
import { SymbolView } from "../../components/AppSymbol";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { AppText as Text } from "../../components/AppText";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { composerActionIsDictation } from "@akeru/client-runtime/dictation";
import { DictationControls } from "../../components/DictationControls";
import { useEnvironmentComposerDictation } from "../../lib/useEnvironmentComposerDictation";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorSelection,
} from "../../components/ComposerEditor";
import {
  ComposerInlineControl,
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { ControlPill } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { buildModelOptions, groupByProvider, resolveModelSendBlock } from "../../lib/modelOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useComposerPathSearch } from "../../state/use-composer-path-search";
import { botEnvironment, environmentBotsAtom, environmentGroupsAtom } from "../../state/bots";
import { providerBotName } from "./thread-list-v2-items";
import { resolveThreadIdentity } from "./threadIdentity";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@akeru/client-runtime/state/runtime";
import { ComposerCommandPopover, type ComposerCommandItem } from "./ComposerCommandPopover";
import { buildComposerCommandItems } from "./composer-command-items";
import { composerMentionItemToken, isThreadMentionQuery } from "./composerMentionItems";
import { ComposerMentionPopover } from "./ComposerMentionPopover";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "./ThreadSettingsSheet";
import { useThreadSettingsSheetRoute } from "./use-thread-settings-sheet-presentation";
import { buildBotUsageCapPatch } from "./botStepUsage";
import {
  ComposerConnectionStatusPill,
  composerConnectionStatus,
} from "./composer-connection-status";
import { COMPOSER_LAYOUT_TRANSITION, ComposerSurface } from "./composer-surface";

export {
  COMPOSER_COLLAPSED_CHROME,
  COMPOSER_EXPANDED_CHROME,
  ComposerSurface,
} from "./composer-surface";

export interface ThreadComposerProps {
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  /**
   * Message sync phase for the selected thread (drives the status pill):
   * "loading" = first fetch, nothing to show yet; "syncing" = cached messages
   * are on screen while they reconcile with the server.
   */
  readonly threadSyncPhase?: "loading" | "syncing" | null;
  readonly selectedThread: OrchestrationThreadShell;
  readonly serverConfig: T3ServerConfig | null;
  readonly queueCount: number;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: () => Promise<MessageId | null>;
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onReconnectEnvironment: () => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** Fires on editor focus/blur; hosts use it to vet stale keyboard state. */
  readonly onEditorFocusChange?: (focused: boolean) => void;
}

const NO_PROVIDERS: NonNullable<ThreadComposerProps["serverConfig"]>["providers"] = [];

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const { t, plural } = useMobileI18n();
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";
  const foregroundColor = useThemeColor("--color-foreground");
  const mutedColor = useThemeColor("--color-icon-muted");
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  const settingsRoutePresentation = useExistingThreadSettingsRoutePresentation();
  const settingsOwnerId = scopedThreadKey(props.environmentId, props.selectedThread.id);

  const clearSettingsRouteSession = useCallback(
    () => settingsRoutePresentation.clear(settingsOwnerId),
    [settingsOwnerId, settingsRoutePresentation.clear],
  );

  const settingsSheetPresentation = useThreadSettingsSheetRoute({
    editorRef: inputRef,
    isEditorFocused: isFocused,
    routeName: "ThreadSettingsSheet",
    onDismissed: clearSettingsRouteSession,
  });

  const bots = useAtomValue(environmentBotsAtom(props.environmentId));

  const subscriptionAuth = useEnvironmentQuery(
    serverEnvironment.subscriptionAuth({ environmentId: props.environmentId, input: {} }),
  );

  const subscriptionStatuses = subscriptionAuth.data?.providers;
  const bot = bots.find((candidate) => candidate.id === props.selectedThread.botId);
  const groups = useAtomValue(environmentGroupsAtom(props.environmentId));

  // Group chats address the group, direct chats the bot. Threads without a
  // configured bot still read as a named teammate: fall back to the provider
  // identity. Until either is known the caller's neutral placeholder stands
  // in, so the composer never asks a bot called "Bot".
  const composerProviderDriver =
    props.serverConfig?.providers.find(
      (candidate) =>
        candidate.instanceId ===
        (props.selectedThread.session?.providerInstanceId ??
          props.selectedThread.modelSelection.instanceId),
    )?.driver ?? null;

  const composerIdentity = resolveThreadIdentity({
    thread: props.selectedThread,
    bots,
    groups,
    providerDriver: composerProviderDriver,
    providerName: providerBotName,
  });

  // Plain chats without a bot or group get no name prompt — the composer
  // placeholder stays neutral rather than echoing the chat title.
  const composerBotName = composerIdentity.isGroup
    ? composerIdentity.title
    : (bot?.name ?? providerBotName(composerProviderDriver));

  const updateBot = useAtomCommand(botEnvironment.update, { reportFailure: false });
  const deleteBot = useAtomCommand(botEnvironment.delete, { reportFailure: false });
  const wasExpandedBeforePreviewRef = useRef(false);
  const inFlightThreadIdsRef = useRef(new Set<string>());
  const { onExpandedChange } = props;

  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);
  const hasContent = props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0;
  // Opening and presentation count as active so the composer stays expanded
  // while focus moves between its native editor and the settings picker.
  const isExpanded = isFocused || settingsSheetPresentation.isActive;

  // The chat keeps its saved model even when it cannot run; Send stays off
  // and the reason shows above the composer until the provider is repaired.
  const sendBlock = useMemo(
    () =>
      resolveModelSendBlock(
        props.serverConfig,
        props.selectedThread.modelSelection,
        t,
        subscriptionStatuses,
      ),
    [props.serverConfig, props.selectedThread.modelSelection, subscriptionStatuses, t],
  );

  const canSend = hasContent && sendBlock === null;

  const sendBlockHint = sendBlock
    ? t("{title}. {description}", { title: sendBlock.title, description: sendBlock.description })
    : undefined;

  // Notify the parent from the derived value, not focus events: the parent
  // sizes the feed inset from this, and blur-during-sheet would otherwise
  // report collapsed while the composer still renders expanded.
  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  const onPressImage = useCallback(
    (uri: string) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewImageUri(uri);
    },
    [isFocused],
  );

  const closePreview = useCallback(() => {
    setPreviewImageUri(null);

    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [inputRef]);

  const onEditorFocusChange = props.onEditorFocusChange;

  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onEditorFocusChange?.(true);
  }, [onEditorFocusChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    onEditorFocusChange?.(false);
  }, [onEditorFocusChange]);

  const showStopAction =
    props.selectedThread.session?.status === "running" ||
    props.selectedThread.session?.status === "starting";

  const sendLabel =
    props.connectionState !== "connected" || props.queueCount > 0 ? "Queue" : "Send";

  const currentModelSelection = props.selectedThread.modelSelection;
  const currentRuntimeMode = props.selectedThread.runtimeMode;

  const connectionStatus = composerConnectionStatus({
    connectionError: props.connectionError,
    connectionState: props.connectionState,
    environmentLabel: props.environmentLabel,
    threadSyncPhase: props.threadSyncPhase,
  });

  const toolbarSurface = String(useThemeColor("--color-card"));
  const backdropSurface = String(useThemeColor("--color-screen"));
  const toolbarFadeOpaque = themeColorWithAlpha(toolbarSurface, 0.95);
  const toolbarFadeTransparent = themeColorWithAlpha(toolbarSurface, 0);
  const backdropGradient = `linear-gradient(to bottom, ${themeColorWithAlpha(backdropSurface, 0)} 0%, ${themeColorWithAlpha(backdropSurface, 0.6)} 55%, ${themeColorWithAlpha(backdropSurface, 0.9)} 100%)`;

  const selectedProviderStatus = useMemo(() => {
    if (!props.serverConfig) return null;

    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    );
  }, [props.serverConfig, props.selectedThread.modelSelection.instanceId]);

  // ── Trigger detection ────────────────────────────────────
  const [composerSelection, setComposerSelection] = useState(() => ({
    start: props.draftMessage.length,
    end: props.draftMessage.length,
  }));

  const [dictationGeneration, setDictationGeneration] = useState(0);

  const dictation = useEnvironmentComposerDictation({
    environmentId: props.environmentId,
    connected: props.connectionState === "connected",
    threadId: props.selectedThread.id,
    draftId: props.selectedThread.id,
    generation: dictationGeneration,
    getDraft: () => ({ text: props.draftMessage, selection: composerSelection }),
    applyDraft: (next) => {
      props.onChangeDraftMessage(next.text);
      setComposerSelection(next.selection);
      inputRef.current?.setSelection(next.selection);
    },
  });

  const showDictation = composerActionIsDictation({
    hasDraft: props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0,
    status: dictation.status,
  });

  useEffect(() => {
    setDictationGeneration((generation) => generation + 1);
  }, [props.environmentId, props.selectedThread.id]);

  // The composer owns dictation, so focusing it and swapping the collapsed
  // control for the expanded one keeps recording. Only the collapsed Stop
  // action takes the slot away; dictation it hides is cancelled.
  const dictationBusy =
    dictation.status === "requesting" ||
    dictation.status === "recording" ||
    dictation.status === "transcribing";

  const dictationHidden = !isExpanded && showStopAction;
  const cancelDictation = dictation.onCancel;
  useEffect(() => {
    if (dictationHidden && dictationBusy) cancelDictation();
  }, [cancelDictation, dictationBusy, dictationHidden]);

  const handleSelectionChange = useCallback((selection: ComposerEditorSelection) => {
    setComposerSelection(selection);
  }, []);

  useEffect(() => {
    const end = props.draftMessage.length;
    setComposerSelection((selection) => {
      const start = Math.min(selection.start, end);
      const selectionEnd = Math.min(selection.end, end);

      if (start === selection.start && selectionEnd === selection.end) {
        return selection;
      }

      return { start, end: selectionEnd };
    });
  }, [props.draftMessage.length]);

  const composerTrigger = useMemo<ComposerTrigger | null>(() => {
    if (composerSelection.start !== composerSelection.end) {
      return null;
    }

    return detectComposerTrigger(props.draftMessage, composerSelection.end);
  }, [composerSelection, props.draftMessage]);

  const mentionQuery = composerTrigger?.kind === "path" ? composerTrigger.query : null;

  const pathSearch = useComposerPathSearch({
    environmentId: props.environmentId,
    cwd: mentionQuery !== null && !isThreadMentionQuery(mentionQuery) ? props.projectCwd : null,
    query: mentionQuery !== null && !isThreadMentionQuery(mentionQuery) ? mentionQuery : null,
  });

  const composerMenuItems = useMemo(
    () => buildComposerCommandItems(composerTrigger, pathSearch.entries, selectedProviderStatus),
    [composerTrigger, pathSearch.entries, selectedProviderStatus],
  );

  // ── Handle command selection ──────────────────────────────
  const { onChangeDraftMessage, draftMessage, onSendMessage } = props;

  const handleSend = useCallback(async () => {
    const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);

    if (inFlightThreadIdsRef.current.has(threadKey)) return;
    inFlightThreadIdsRef.current.add(threadKey);

    try {
      const messageId = await onSendMessage();

      if (messageId === null) {
        return;
      }

      setDictationGeneration((generation) => generation + 1);
    } finally {
      inFlightThreadIdsRef.current.delete(threadKey);
    }
  }, [onSendMessage, props.environmentId, props.selectedThread.id]);

  const handleCommandSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!composerTrigger) return;

      let replacement = "";

      if (item.type === "path") {
        replacement = `${serializeComposerFileLink(item.path)} `;
      } else if (item.type === "skill") {
        replacement = `$${item.skill.name} `;
      } else if (item.type === "slash-command") {
        replacement = `/${item.command} `;
      } else if (item.type === "provider-slash-command") {
        replacement = `/${item.command.name} `;
      } else {
        const token = composerMentionItemToken(item);

        if (token !== null) replacement = `${token} `;
      }

      const result = replaceTextRange(
        draftMessage,
        composerTrigger.rangeStart,
        composerTrigger.rangeEnd,
        replacement,
      );

      setComposerSelection({ start: result.cursor, end: result.cursor });
      onChangeDraftMessage(result.text);
    },
    [composerTrigger, draftMessage, onChangeDraftMessage],
  );

  // ── Model menu ───────────────────────────────────────────
  const modelOptions = useMemo(
    () => buildModelOptions(props.serverConfig, currentModelSelection, subscriptionStatuses, t),
    [props.serverConfig, currentModelSelection, subscriptionStatuses, t],
  );

  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);

  // An existing thread is bound to its harness: sessions can't move between
  // provider instances, so the picker only offers the thread's own group.
  const threadProviderGroups = useMemo(
    () => providerGroups.filter((group) => group.providerKey === currentModelSelection.instanceId),
    [providerGroups, currentModelSelection.instanceId],
  );

  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;

  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: currentModelSelection.options,
      }),
    [currentModelOption?.capabilities, currentModelSelection.options],
  );

  const updateBotUsageCap = useCallback(
    async (input: string) => {
      if (!bot) return false;
      const patch = buildBotUsageCapPatch(bot.id, input, currentModelOption?.providerDriver);

      if (!patch) return false;
      const result = await updateBot({ environmentId: props.environmentId, input: patch });

      return result._tag === "Success";
    },
    [bot, currentModelOption?.providerDriver, props.environmentId, updateBot],
  );

  const deleteThreadBot = useCallback(async () => {
    if (!bot) return t("The command failed.");

    const result = await deleteBot({
      environmentId: props.environmentId,
      input: { botId: bot.id },
    });

    if (result._tag !== "Failure") return null;
    const error = squashAtomCommandFailure(result);

    return error instanceof Error ? error.message : t("The command failed.");
  }, [bot, deleteBot, props.environmentId, t]);

  const settingsRouteSession = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId: settingsOwnerId,
      providerGroups: threadProviderGroups,
      selectedModel: currentModelSelection,
      onSelectModel: (option) => props.onUpdateModelSelection(option.selection),
      optionDescriptors: providerOptionDescriptors,
      onUpdateOptionSelections: (options) =>
        props.onUpdateModelSelection({ ...currentModelSelection, options }),
      runtimeMode: currentRuntimeMode,
      onUpdateRuntimeMode: props.onUpdateRuntimeMode,
      ...(bot
        ? {
            memoryThreadRef: {
              environmentId: props.environmentId,
              threadId: props.selectedThread.id,
            },
            routinesRef: {
              environmentId: props.environmentId,
              botId: bot.id,
              botName: bot.name,
            },
          }
        : {}),
      ...(bot
        ? {
            botUsageCap: bot.usageCap,
            botUsageCapProviderDriver: currentModelOption?.providerDriver,
            onUpdateBotUsageCap: updateBotUsageCap,
            onDeleteBot: deleteThreadBot,
          }
        : {}),
    }),
    [
      currentModelSelection,
      currentRuntimeMode,
      bot,
      deleteThreadBot,
      props.environmentId,
      props.onUpdateModelSelection,
      props.onUpdateRuntimeMode,
      props.selectedThread.id,
      providerOptionDescriptors,
      settingsOwnerId,
      threadProviderGroups,
      updateBotUsageCap,
    ],
  );

  const openSettings = useCallback(() => {
    settingsRoutePresentation.present(settingsRouteSession);
    settingsSheetPresentation.open();
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.open]);

  useEffect(() => {
    if (settingsSheetPresentation.isActive) {
      settingsRoutePresentation.present(settingsRouteSession);
    }
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.isActive]);

  return (
    <Animated.View
      className="px-4"
      layout={COMPOSER_LAYOUT_TRANSITION}
      style={{
        paddingTop: isExpanded ? 8 : 6,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 8 : 6),
      }}
    >
      {/* The backdrop gradient lives on a plain View: Reanimated's Animated.View
          silently drops experimental_backgroundImage on Android, which left this
          strip fully transparent and the feed text legible through the composer. */}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            experimental_backgroundImage: backdropGradient,
          },
        ]}
      />
      <Animated.View
        className="relative w-full self-center"
        layout={COMPOSER_LAYOUT_TRANSITION}
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {composerTrigger?.kind === "path" && !composerTrigger.query.startsWith('"') ? (
          <ComposerMentionPopover
            environmentId={props.environmentId}
            threadId={props.selectedThread.id}
            projectId={props.selectedThread.projectId}
            groupId={props.selectedThread.groupId ?? null}
            browserAvailable={props.serverConfig?.settings.enableAgentBrowserAccess === true}
            providers={props.serverConfig?.providers ?? NO_PROVIDERS}
            query={composerTrigger.query}
            fileItems={composerMenuItems}
            isLoading={pathSearch.isPending}
            onSelect={handleCommandSelect}
          />
        ) : composerTrigger &&
          // `$` stays open when empty so a missing provider or skill is stated, not silent.
          (composerMenuItems.length > 0 || composerTrigger.kind === "skill") ? (
          <View className="absolute inset-x-0 bottom-full z-10 mb-2">
            <ComposerCommandPopover
              items={composerMenuItems}
              triggerKind={composerTrigger.kind}
              isLoading={pathSearch.isPending}
              {...(composerTrigger.kind === "skill" && selectedProviderStatus === null
                ? { emptyText: t("Connect a provider to use skills.") }
                : {})}
              onSelect={handleCommandSelect}
            />
          </View>
        ) : null}

        {connectionStatus ? (
          <ComposerConnectionStatusPill
            status={connectionStatus}
            onPress={props.onReconnectEnvironment}
          />
        ) : sendBlock ? (
          // In flow, not absolute: the overlay's measured height becomes the
          // feed's bottom inset, so the notice stacks above the pill instead
          // of painting over the feed and the waiting line.
          <View
            accessibilityRole="alert"
            className="mb-2 rounded-2xl border border-border bg-card px-4 py-2"
            pointerEvents="none"
          >
            <Text className="text-center text-xs text-foreground-muted">
              <Text className="text-xs font-t3-bold text-foreground">
                {t("{title}.", { title: sendBlock.title })}
              </Text>{" "}
              {sendBlock.description}
            </Text>
          </View>
        ) : null}

        <ComposerSurface
          isDarkMode={isDarkMode}
          style={
            isExpanded
              ? {
                  borderRadius: 26,
                  minHeight: 140,
                  overflow: "hidden" as const,
                  paddingBottom: 6,
                  paddingHorizontal: 14,
                  paddingTop: 14,
                }
              : {
                  borderRadius: 999,
                  overflow: "hidden" as const,
                  flexDirection: "row" as const,
                  alignItems: "center" as const,
                  paddingLeft: 18,
                  paddingRight: 5,
                  paddingVertical: 5,
                }
          }
        >
          {/* Attachment strip — inside the card, above the text input */}
          {isExpanded ? (
            <Animated.View
              className={props.draftAttachments.length > 0 ? "pb-2.5" : undefined}
              entering={FadeIn.duration(160)}
              exiting={FadeOut.duration(120)}
            >
              <ComposerAttachmentStrip
                attachments={props.draftAttachments}
                onRemove={props.onRemoveDraftImage}
                onPressImage={onPressImage}
              />
            </Animated.View>
          ) : null}

          {!isExpanded ? (
            <Pressable
              accessibilityLabel="Add attachment"
              accessibilityRole="button"
              className="mr-1 size-9 items-center justify-center rounded-full bg-subtle"
              hitSlop={6}
              onPress={() => void props.onPickDraftImages()}
              style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
            >
              <SymbolView name="plus" size={18} tintColor={mutedColor} type="monochrome" />
            </Pressable>
          ) : null}
          {!isExpanded && !hasContent ? (
            <Pressable
              accessibilityLabel="Model and reasoning settings"
              accessibilityRole="button"
              className="mr-1 max-w-[112px] flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 py-2"
              onPress={openSettings}
              style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
            >
              <ProviderIcon provider={currentModelOption?.providerDriver} size={15} />
              <Text
                className="shrink text-xs font-t3-medium text-foreground-muted"
                numberOfLines={1}
              >
                {currentModelOption?.label ?? "Model"}
              </Text>
            </Pressable>
          ) : null}
          <View className={isExpanded ? undefined : "min-w-0 flex-1"}>
            <ComposerEditor
              ref={inputRef}
              multiline
              value={props.draftMessage}
              skills={selectedProviderStatus?.skills ?? []}
              selection={composerSelection}
              onChangeText={props.onChangeDraftMessage}
              onSelectionChange={handleSelectionChange}
              onPasteImages={(uris) => void props.onNativePasteImages(uris)}
              placeholder={
                composerBotName ? t("Message {name}", { name: composerBotName }) : props.placeholder
              }
              onFocus={handleFocus}
              onBlur={handleBlur}
              onSubmit={handleSend}
              scrollEnabled={isExpanded}
              // Android: collapsed single line centers natively (gravity) in
              // a pill-height box matching the send button; iOS keeps insets.
              singleLineCentered={!isExpanded}
              contentInsetVertical={isExpanded || Platform.OS === "android" ? 0 : 6}
              style={
                isExpanded
                  ? {
                      minHeight: 72,
                      maxHeight: 160,
                      paddingHorizontal: 4,
                      paddingVertical: 4,
                    }
                  : {
                      height: 36,
                    }
              }
              textStyle={{
                ...bodyText,
                color: foregroundColor,
              }}
            />
          </View>
          {!isExpanded && props.draftAttachments.length > 0 ? (
            <View className="flex-row gap-1 pl-1">
              {props.draftAttachments.slice(0, 3).map((image) => (
                <Pressable key={image.id} onPress={() => onPressImage(image.previewUri)}>
                  <Image
                    source={{ uri: image.previewUri }}
                    className="size-[30px] rounded-lg bg-subtle"
                    resizeMode="cover"
                  />
                </Pressable>
              ))}
              {props.draftAttachments.length > 3 ? (
                <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                  <Text className="text-foreground-muted text-2xs font-t3-bold">
                    +{props.draftAttachments.length - 3}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {!isExpanded ? (
            <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(100)}>
              {showStopAction ? (
                <ControlPill icon="stop.fill" variant="danger" onPress={props.onStopThread} />
              ) : showDictation ? (
                <DictationControls appearance="send-slot" {...dictation} />
              ) : (
                <ControlPill
                  accessibilityLabel={sendLabel}
                  accessibilityHint={sendBlockHint}
                  icon="arrow.up"
                  variant="primary"
                  disabled={!canSend}
                  onPress={handleSend}
                />
              )}
            </Animated.View>
          ) : null}
          {isExpanded ? (
            <ComposerToolbarRow paddingBottom={0} paddingHorizontal={0} paddingTop={4}>
              <ComposerToolbarScroller
                fadeOpaque={toolbarFadeOpaque}
                fadeTransparent={toolbarFadeTransparent}
                contentPaddingRight={8}
              >
                <ComposerToolbarButton
                  accessibilityLabel={t("Add attachment")}
                  icon="plus"
                  onPress={() => void props.onPickDraftImages()}
                  showChevron={false}
                />
                <ComposerInlineControl
                  accessibilityLabel={t("Model and reasoning settings")}
                  emphasized
                  iconNode={
                    <ProviderIcon provider={currentModelOption?.providerDriver} size={16} />
                  }
                  label={currentModelOption?.label ?? currentModelSelection.model}
                  maxWidth={152}
                  onPress={openSettings}
                />
                {showStopAction ? (
                  <ComposerToolbarButton
                    accessibilityLabel={t("Stop")}
                    icon="stop.fill"
                    variant="danger"
                    onPress={props.onStopThread}
                    showChevron={false}
                  />
                ) : null}
              </ComposerToolbarScroller>
              {showDictation ? (
                <DictationControls appearance="send-slot" {...dictation} />
              ) : (
                <ComposerToolbarButton
                  accessibilityLabel={sendLabel}
                  accessibilityHint={sendBlockHint}
                  icon="arrow.up"
                  variant="primary"
                  disabled={!canSend}
                  onPress={handleSend}
                  showChevron={false}
                />
              )}
            </ComposerToolbarRow>
          ) : null}
        </ComposerSurface>

        {/* Queue count */}
        {props.queueCount > 0 ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
            <Text className="pt-2 text-xs text-foreground-muted">
              {plural(props.queueCount, {
                one: "{count} queued message will send automatically.",
                other: "{count} queued messages will send automatically.",
              })}
            </Text>
          </Animated.View>
        ) : null}
      </Animated.View>

      <ImageViewing
        images={previewImageUri ? [{ uri: previewImageUri }] : []}
        imageIndex={0}
        visible={previewImageUri !== null}
        onRequestClose={closePreview}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </Animated.View>
  );
});
