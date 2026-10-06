import { Predicate } from "effect";
import { pendingMemoryApprovals } from "@akeru/client-runtime/durable-memory";
import { useAtomValue } from "@effect/atom-react";
import { presentThreadError } from "@akeru/client-runtime/errors";
import { BotId, type EnvironmentId, type TurnId } from "@akeru/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useId, useMemo, useState } from "react";

import { selectOpenBotInboxItems } from "../../botInbox";
import { canManageChannels, connectedChannelBinding } from "../../channelAccess";
import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadActivities } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { environmentSnapshotAtom } from "../../state/shell";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import { openSettings } from "../../settingsDialogStore";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { threadSilentRun } from "@akeru/client-runtime/silent-run";
import { botActivityUpdate, BotActivityStatus } from "./BotActivityStatus";
import { deriveBotActivity } from "./botActivityStatus.logic";
import { BotApprovalPrompt } from "./BotApprovalPrompt";
import { MemoryApprovalPrompt } from "./MemoryApprovalPrompt";
import { BotInboxAlertStack } from "./BotInboxAlertStack";
import { ChatReplyContext } from "../markdown/generative/chatReplyContext";
import { BotAvatarView } from "./BotAvatarView";
import { BotConversationScrollArea } from "./BotConversationScrollArea";
import { useBotDetailsOpen } from "./detailsPanelOpen";
import { DelegationCard } from "./DelegationCard";
import {
  AssistantMessageRow,
  type ChannelApprovalTarget,
  type MessageReplyHandler,
  UserMessageRow,
  useMessageReactionUpdater,
} from "./BotChatMessageRows";
import { channelOriginForAssistantMessage } from "@akeru/client-runtime/channel-origin-presentation";
import {
  buildBotConversationEntries,
  isBotConversationWorking,
  visibleBotChatMessages,
} from "./botConversationPresentation";
import { botEngineFailureContext, botEngineSubscriptionToConnect } from "./botEngineSelection";
import { ProviderConnectCard, providerConnectStep } from "../chat/ProviderConnectCard";
import { useSubscriptionStatuses } from "../settings/ProvidersPanel";
import { BotTurnFailureRow } from "./BotTurnFailureRow";
import { useBotEngineAvailability } from "./useBotEngineAvailability";
import { BotPromptComposer } from "./BotPromptComposer";
import {
  clearDesktopOnboardingFirstChat,
  desktopOnboardingPromptChipItems,
  readDesktopOnboardingFirstChatBotId,
  shouldShowDesktopOnboardingPromptChips,
} from "../onboarding/desktopOnboarding.logic";
import { useAnsweredUserInputs } from "./useAnsweredUserInputs";
import { useBotPromptMentionScope } from "./BotPromptMentions";
import { buildBotStepMeters } from "@akeru/client-runtime/bot-step-usage";
import { ThreadErrorBanner } from "../chat/ThreadErrorBanner";
import { ProviderUnavailableLine } from "../chat/ProviderUnavailableNotice";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { PluginSearchResultCard } from "../chat/PluginSearchResultCard";
import {
  buildReplyPrompt,
  findReplySourceMessageId,
  type MessageReplyTarget,
} from "../chat/MessageControls";
import { ConversationSeparator } from "../chat/ConversationSeparator";
import { useOptionalReplyPlayback } from "../chat/ReplyPlaybackProvider";
import { useReplyPlaybackThread } from "~/lib/replyPlaybackThread";
import { BotVoiceCallButton, useVoiceCall } from "../voice/VoiceCall";
import { useBotPresence } from "./botPresence";
import { useMessageArrivals } from "./messageArrival";
import { useRosterStore } from "./rosterStore";
import { useBotThreadRuntime } from "./useBotThreadRuntime";
import { useLocalDay } from "./useLocalDay";
import { useRosterPendingApproval } from "./useRosterPendingApproval";
import { useEnableBotAutoReview, useRosterLoadState } from "./useServerRoster";
import { RosterLoadStatus } from "./RosterLoadStatus";
import { deriveWorkLogEntries, pluginSearchResultForWorkEntry } from "../../session-logic";
import { activeThreadRuntimeWarning } from "./threadRuntimeWarning.logic";
import { RoutineReceiptRow } from "./RoutineReceiptRow";
import { useBotLandingTimeline } from "./useBotLandingTimeline";
import { resolveRoutedBot } from "./rosterRouteSelection";
import { ThreadRuntimeWarningBanner } from "./ThreadRuntimeWarningBanner";
import { ChatActionsMenu, useMarkChatVisited } from "../chat/ChatActionsMenu";

// SAFETY: the empty ID is an inactive-query sentinel; no environment request is sent for it.
const NO_ENVIRONMENT = "" as EnvironmentId;

export function BotThreadLanding({
  botId,
  onOpenRoutines,
}: {
  readonly botId: string;
  readonly onOpenRoutines?: () => void;
}) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  // SAFETY: the empty ID is an inactive-query sentinel; no environment request is sent for it.
  const channelSession = useEnvironmentSessionState(environmentId ?? ("" as EnvironmentId));
  const canManageChannelBindings = canManageChannels(channelSession.data);
  const bots = useRosterStore((state) => state.bots);
  const rosterEnvironmentId = useRosterStore((state) => state.environmentId);
  const routedBot = resolveRoutedBot(environmentId, rosterEnvironmentId, bots, botId);
  const rosterLoadState = useRosterLoadState();
  const bot = routedBot.status === "available" ? routedBot.bot : undefined;
  const [replyTarget, setReplyTarget] = useState<MessageReplyTarget | null>(null);

  const [firstChatBotId, setFirstChatBotId] = useState(() =>
    readDesktopOnboardingFirstChatBotId(window.localStorage),
  );

  const dismissFirstChatChips = useCallback(() => {
    clearDesktopOnboardingFirstChat(window.localStorage);
    setFirstChatBotId(null);
  }, []);

  const {
    instanceEntries,
    selection: stickyEngine,
    unavailability: engineUnavailability,
    blocked: sendBlocked,
    catalog: engineCatalog,
  } = useBotEngineAvailability(bot?.engine ?? null);

  const runtime = useBotThreadRuntime(botId, stickyEngine);
  useMarkChatVisited(runtime.linkedThreadRef);

  const newChat = useMemo(
    () => ({ canStart: runtime.canStartNewChat, start: runtime.startNewChat }),
    [runtime.canStartNewChat, runtime.startNewChat],
  );

  const mentionScope = useBotPromptMentionScope({
    environmentId,
    threadRef: runtime.linkedThreadRef,
    projectId: runtime.defaultProject?.id,
    cwd: runtime.defaultProject?.workspaceRoot,
  });

  const engineNoticeId = useId();

  const failureContext = botEngineFailureContext(
    stickyEngine,
    instanceEntries,
    runtime.failure?.unavailability,
    runtime.failure?.providerInstanceId,
  );

  const { statusByProvider: subscriptionStatuses } = useSubscriptionStatuses(environmentId);

  const subscriptionToConnect = botEngineSubscriptionToConnect(
    stickyEngine,
    instanceEntries,
    sendBlocked ? engineUnavailability?.reason : runtime.failure?.unavailability,
  );

  // Signing in fixes this chat, so the connect card replaces the failure copy.
  const connectNeeded =
    subscriptionToConnect !== null &&
    providerConnectStep(subscriptionStatuses.get(subscriptionToConnect)) !== null;

  const openBotSettings = () => void navigate({ to: "/bots/$botId/settings", params: { botId } });
  const approvalState = useRosterPendingApproval(runtime.linkedThreadRef);
  const enableAutoReview = useEnableBotAutoReview();
  const activities = useThreadActivities(runtime.linkedThreadRef);
  const memoryApprovals = useMemo(() => pendingMemoryApprovals(activities), [activities]);
  const stepMeters = useMemo(() => buildBotStepMeters(activities), [activities]);

  const botActivity = useMemo(
    () => deriveBotActivity(activities, runtime.latestTurn),
    [activities, runtime.latestTurn],
  );

  const runtimeWarning = useMemo(
    () => activeThreadRuntimeWarning(activities, runtime.latestTurn),
    [activities, runtime.latestTurn],
  );

  const pluginResultsByTurn = useMemo(() => {
    const results = new Map<
      TurnId,
      {
        readonly id: string;
        readonly result: NonNullable<ReturnType<typeof pluginSearchResultForWorkEntry>>;
      }[]
    >();

    for (const entry of deriveWorkLogEntries(activities)) {
      const result = pluginSearchResultForWorkEntry(entry);

      if (!result || !entry.turnId) continue;
      const turnResults = results.get(entry.turnId) ?? [];
      turnResults.push({ id: entry.id, result });
      results.set(entry.turnId, turnResults);
    }

    return results;
  }, [activities]);

  const voiceCall = useVoiceCall();
  const replyPlayback = useOptionalReplyPlayback();
  const presence = useBotPresence(botId);

  const inboxQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );

  const snapshot = useAtomValue(environmentSnapshotAtom(environmentId ?? NO_ENVIRONMENT));

  useEffect(() => {
    setReplyTarget(null);
  }, [botId, runtime.linkedThreadRef?.environmentId, runtime.linkedThreadRef?.threadId]);

  useEffect(() => {
    if (routedBot.status === "loading") return;

    if (routedBot.status === "missing") {
      void navigate({ to: "/", replace: true });

      return;
    }

    useRosterStore.getState().selectBot(botId);
  }, [botId, navigate, routedBot.status]);

  const activeUserInput = runtime.pendingUserInputs[0] ?? null;

  const waitingForUserInput =
    activeUserInput !== null && !runtime.respondingRequestIds.includes(activeUserInput.requestId);

  const working = isBotConversationWorking({
    sending: runtime.sending,
    respondingToUserInput: runtime.respondingRequestIds.length > 0,
    presence,
    turnRunning: runtime.latestTurn?.state === "running",
    waitingForUserInput,
  });

  const workingUpdate = botActivityUpdate(activities, runtime.latestTurn?.turnId ?? null, t);

  const silentRun = runtime.latestTurn?.completedAt
    ? null
    : threadSilentRun(activities, runtime.latestTurn?.turnId);

  const messages = useMemo(
    () => visibleBotChatMessages(runtime.messages, working),
    [runtime.messages, working],
  );

  const answeredUserInputs = useAnsweredUserInputs(activities, messages);

  const today = useLocalDay();
  const todayLabel = t("Today");

  const entries = useMemo(
    () => buildBotConversationEntries(messages, today, todayLabel, locale),
    [messages, today, todayLabel, locale],
  );

  const { timelineItems, delegations, waitingOnChildren, olderRoutineNotes } =
    useBotLandingTimeline({ threadRef: runtime.linkedThreadRef, snapshot, entries });

  const arrivedMessageIds = useMessageArrivals(
    { owner: botId, thread: runtime.linkedThreadRef?.threadId ?? null },
    messages.map((message) => message.id),
  );

  const available = bot?.archivedAt === null;
  const [detailsPanelOpen] = useBotDetailsOpen(bot?.id ?? botId);

  const playbackKey = useReplyPlaybackThread({
    environmentId: available ? (runtime.linkedThreadRef?.environmentId ?? environmentId) : null,
    threadId: available ? runtime.linkedThreadRef?.threadId : null,
    messages: available ? messages : [],
    mediaBlocked: Boolean(voiceCall.activeCall || voiceCall.startingBotId),
  });

  const updateReaction = useMessageReactionUpdater(runtime.linkedThreadRef);

  const replyTo = useCallback<MessageReplyHandler>(
    (messageId, label, text) => setReplyTarget({ messageId, label, text }),
    [],
  );

  if (routedBot.status === "loading") {
    if (rosterLoadState.kind === "failed") {
      return (
        <SidebarInset
          tone="muted"
          aria-label={t("Could not load bots")}
          className="h-dvh min-h-0 overflow-hidden"
        >
          <RosterLoadStatus state={rosterLoadState} variant="page" />
        </SidebarInset>
      );
    }

    return (
      <SidebarInset
        tone="muted"
        aria-label={t("Loading bot…")}
        className="h-dvh min-h-0 items-center justify-center overflow-hidden"
      >
        <div className="flex flex-1 items-center justify-center gap-2 text-sm" role="status">
          <Spinner aria-hidden="true" className="size-4" />
          {t("Loading bot…")}
        </div>
      </SidebarInset>
    );
  }

  if (!bot) return null;

  const assistantTurnIds = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" && message.turnId !== null ? [message.turnId] : [],
    ),
  );

  const pendingPluginResults = [...pluginResultsByTurn.entries()].filter(
    ([turnId]) => !assistantTurnIds.has(turnId),
  );

  const pendingApproval = approvalState.pendingApproval;
  const inboxItems = selectOpenBotInboxItems(inboxQuery.data?.inbox ?? [], new Set([bot.id]));

  const activeBot = (id: string) =>
    bots.find((candidate) => candidate.id === id && candidate.archivedAt === null) ?? null;

  const currentPersonId = snapshot?.currentPersonId;
  const reactionHandler = runtime.linkedThreadRef !== null ? updateReaction : null;
  const linkedThreadId = runtime.linkedThreadRef?.threadId;

  const channelApprovalFor = (messageIndex: number): ChannelApprovalTarget | null => {
    if (!environmentId || !linkedThreadId) return null;
    const message = messages[messageIndex];

    if (!message) return null;
    const origin = channelOriginForAssistantMessage(messages, messageIndex);

    if (!origin) {
      // The inbound message is on an older, unloaded page: keep the delivery label only.
      return message.channelDelivery === undefined
        ? null
        : {
            environmentId,
            botId: BotId.make(bot.id),
            threadId: linkedThreadId,
            origin: null,
            sent: false,
            canSend: false,
          };
    }

    const binding = connectedChannelBinding(bot.channelBindings, origin.provider);
    // Only channel admins with a live binding may trigger a send.
    const canSend = canManageChannelBindings && binding !== undefined;

    if (message.channelDelivery === undefined && !canSend) return null;

    return {
      environmentId,
      botId: BotId.make(bot.id),
      threadId: linkedThreadId,
      origin,
      sent: binding?.sentMessageIds.includes(message.id) ?? false,
      canSend,
    };
  };

  const chatReply = {
    disabled:
      runtime.sending ||
      runtime.latestTurn?.state === "running" ||
      runtime.pendingUserInputs.length > 0 ||
      pendingApproval !== null ||
      sendBlocked ||
      !runtime.botReady,
    send: (text: string) => runtime.send(text, []),
  };

  return (
    <ChatReplyContext value={chatReply}>
      <SidebarInset
        tone="foreground"
        aria-label={t("{name} chat", { name: bot.name })}
        className="h-dvh min-h-0 overflow-hidden"
        data-testid="bot-thread-landing"
      >
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <WorkspacePageHeader
              className="border-b border-border"
              detailsPanelOpen={detailsPanelOpen}
            >
              <div className="flex min-w-0 items-center gap-2">
                <BotAvatarView avatar={bot.avatar} name={bot.name} className="size-6" />
                <span className="truncate text-sm font-medium">{bot.name}</span>
              </div>
              <div data-chat-header-actions className="ml-auto flex items-center">
                <BotVoiceCallButton
                  bot={bot}
                  disabled={runtime.sending || runtime.latestTurn?.state === "running"}
                />
                {available ? (
                  <ChatActionsMenu threadRef={runtime.linkedThreadRef} newChat={newChat} />
                ) : null}
              </div>
            </WorkspacePageHeader>
            <BotConversationScrollArea
              followKey={messages.findLast((message) => message.role === "user")?.id}
            >
              {olderRoutineNotes.nextCursor ? (
                <button
                  type="button"
                  className="mx-auto my-3 block rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  disabled={olderRoutineNotes.isPending}
                  onClick={olderRoutineNotes.load}
                >
                  {olderRoutineNotes.isPending
                    ? t("Loading older routine notes…")
                    : olderRoutineNotes.error
                      ? t("Retry older routine notes")
                      : t("Load older routine notes")}
                </button>
              ) : null}
              {timelineItems.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12">
                  <BotAvatarView avatar={bot.avatar} name={bot.name} className="size-14" />
                  <h1 className="text-lg font-medium">{t("Message {name}", { name: bot.name })}</h1>
                </div>
              ) : (
                timelineItems.map((item, timelineIndex) => (
                  <Fragment key={item.key}>
                    {Predicate.isTagged(item, "Receipt") ? (
                      <RoutineReceiptRow
                        receipt={item.receipt}
                        {...(onOpenRoutines ? { onOpenRoutines } : {})}
                      />
                    ) : Predicate.isTagged(item, "Delegation") ? (
                      <DelegationCard
                        delegation={item.delegation}
                        delegations={delegations}
                        childBot={activeBot(item.delegation.childBotId)}
                        parentBot={activeBot(item.delegation.parentBotId)}
                      />
                    ) : (
                      (() => {
                        const { message, separator, startsGroup } = item.message.entry;

                        const startsAfterReceipt = Predicate.isTagged(
                          timelineItems[timelineIndex - 1] ?? {},
                          "Receipt",
                        );

                        const messageIndex = item.index;

                        return (
                          <>
                            {separator ? <ConversationSeparator label={separator} /> : null}
                            {message.role === "assistant" ? (
                              <AssistantMessageRow
                                message={message}
                                arrived={arrivedMessageIds.has(message.id)}
                                author={bot}
                                testId="bot-provider-message"
                                startsGroup={startsGroup || startsAfterReceipt}
                                cwd={runtime.defaultProject?.workspaceRoot}
                                threadRef={runtime.linkedThreadRef ?? undefined}
                                stepMeter={
                                  message.turnId === null
                                    ? undefined
                                    : stepMeters.get(message.turnId)
                                }
                                pluginResults={
                                  message.turnId === null
                                    ? undefined
                                    : pluginResultsByTurn.get(message.turnId)
                                }
                                currentPersonId={currentPersonId}
                                playback={replyPlayback}
                                playbackKey={playbackKey}
                                channelApproval={channelApprovalFor(messageIndex)}
                                onReply={replyTo}
                                onReactionChange={reactionHandler}
                              />
                            ) : (
                              <UserMessageRow
                                message={message}
                                replySourceMessageId={findReplySourceMessageId(
                                  messages,
                                  messageIndex,
                                  message.text,
                                )}
                                arrived={arrivedMessageIds.has(message.id)}
                                testId="bot-user-message"
                                startsGroup={startsGroup || startsAfterReceipt}
                                replyLabel="you"
                                showChannelOrigin
                                skills={engineCatalog?.skills}
                                environmentId={environmentId}
                                currentPersonId={currentPersonId}
                                answered={answeredUserInputs.get(message.id) ?? null}
                                onReply={replyTo}
                                onReactionChange={reactionHandler}
                              />
                            )}
                          </>
                        );
                      })()
                    )}
                  </Fragment>
                ))
              )}
              {pendingPluginResults.map(([turnId, results]) => (
                <div className="flex items-start gap-3" key={`${turnId}:plugins`}>
                  <BotAvatarView
                    avatar={bot.avatar}
                    name={bot.name}
                    className="mt-0.5 size-7 shrink-0"
                  />
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="text-sm font-medium">{bot.name}</div>
                    {results.map(({ id, result }) => (
                      <PluginSearchResultCard key={id} result={result} />
                    ))}
                  </div>
                </div>
              ))}
              {runtime.pendingUserInputs.length > 0 ? (
                <div className="flex items-start gap-3">
                  <BotAvatarView
                    avatar={bot.avatar}
                    name={bot.name}
                    className="mt-0.5 size-7 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 text-sm font-medium">{bot.name}</div>
                    <ComposerPendingUserInputPanel
                      pendingUserInputs={runtime.pendingUserInputs}
                      respondingRequestIds={runtime.respondingRequestIds}
                      answers={runtime.pendingUserInputAnswers}
                      step={runtime.pendingUserInputStep}
                      onStepChange={runtime.setPendingUserInputStep}
                      onSelectOption={runtime.selectPendingUserInputOption}
                      onAnswerWithText={(text) => {
                        void runtime.answerPendingUserInputWithText(text);
                      }}
                      onSubmit={() => {
                        void runtime.submitPendingUserInputAnswers();
                      }}
                    />
                  </div>
                </div>
              ) : null}
              {!working && runtime.turnFailure && messages.at(-1)?.role === "user" ? (
                <BotTurnFailureRow
                  botName={bot.name}
                  title={presentThreadError(runtime.turnFailure.message, failureContext, t).title}
                />
              ) : null}
              {waitingOnChildren && !working ? (
                <p className="ml-10 text-xs text-muted-foreground" aria-live="polite">
                  {t("Waiting on delegated work")}
                </p>
              ) : null}
            </BotConversationScrollArea>
            <BotInboxAlertStack
              items={inboxItems}
              onOpenDetails={() => openSettings("advanced", "errors", environmentId)}
            />
            <ThreadRuntimeWarningBanner warning={runtimeWarning} />
            {connectNeeded && subscriptionToConnect ? (
              <ProviderConnectCard
                id={engineNoticeId}
                environmentId={environmentId}
                provider={subscriptionToConnect}
                botName={bot.name}
                className="mt-2"
              />
            ) : null}
            <ThreadErrorBanner
              threadKey={`${runtime.linkedThreadRef?.environmentId ?? environmentId ?? "unknown"}:${runtime.linkedThreadRef?.threadId ?? bot.id}`}
              error={
                connectNeeded ||
                inboxItems.some((item) => item.lastFailure === runtime.error) ||
                (sendBlocked && runtime.failure?.unavailability === engineUnavailability?.reason)
                  ? null
                  : runtime.error
              }
              context={failureContext}
              environmentId={environmentId}
              onOpenUsage={openBotSettings}
              {...(runtime.canResume ? { onResume: () => void runtime.resume() } : {})}
              resuming={runtime.resuming}
            />
            <BotPromptComposer
              typeToFocus={!waitingForUserInput}
              mentionScope={mentionScope}
              commandCatalog={engineCatalog}
              botName={bot.name}
              draftKey={bot.id}
              busy={working && pendingApproval === null}
              activitySlot={
                working && !waitingForUserInput && pendingApproval === null ? (
                  <BotActivityStatus
                    name={bot.name}
                    activity={botActivity}
                    update={workingUpdate}
                    silentRun={silentRun}
                  />
                ) : null
              }
              pendingActionSlot={
                pendingApproval ? (
                  <BotApprovalPrompt
                    approval={pendingApproval}
                    pendingCount={approvalState.pendingCount}
                    responding={approvalState.responding}
                    error={approvalState.responseError}
                    onRespond={async (decision) => {
                      const answered = await approvalState.respond(
                        pendingApproval.requestId,
                        decision,
                      );

                      if (answered && decision === "acceptAlways" && bot) {
                        await enableAutoReview(bot.id);
                      }

                      return answered;
                    }}
                  />
                ) : memoryApprovals.length > 0 && runtime.linkedThreadRef ? (
                  <MemoryApprovalPrompt
                    threadRef={runtime.linkedThreadRef}
                    approvals={memoryApprovals}
                    currentBotId={bot.id}
                  />
                ) : null
              }
              quietSurface={pendingApproval !== null}
              disabled={
                pendingApproval !== null ||
                runtime.respondingRequestIds.length > 0 ||
                voiceCall.activeCall?.botId === bot.id ||
                voiceCall.startingBotId === bot.id ||
                sendBlocked ||
                !runtime.botReady ||
                !runtime.bootstrapped ||
                runtime.defaultProject === null
              }
              replyPreview={replyTarget}
              onCancelReply={() => setReplyTarget(null)}
              sendBlockedDescriptionId={sendBlocked ? engineNoticeId : undefined}
              autoFocus={shouldShowDesktopOnboardingPromptChips({
                desktop: isElectron,
                botId: bot.id,
                firstChatBotId,
                hasMessages: runtime.hasMessages,
                composerEmpty: true,
              })}
              promptSuggestions={
                shouldShowDesktopOnboardingPromptChips({
                  desktop: isElectron,
                  botId: bot.id,
                  firstChatBotId,
                  hasMessages: runtime.hasMessages,
                  composerEmpty: true,
                })
                  ? desktopOnboardingPromptChipItems(t)
                  : undefined
              }
              onPromptSuggestionType={dismissFirstChatChips}
              onSubmit={async (prompt, files) => {
                const sent = await runtime.send(buildReplyPrompt(replyTarget, prompt), files);

                if (sent) {
                  dismissFirstChatChips();
                  setReplyTarget(null);
                }

                return sent;
              }}
            />
            {connectNeeded ? null : sendBlocked && engineUnavailability ? (
              <ProviderUnavailableLine
                provider={engineUnavailability.provider}
                id={engineNoticeId}
                presentation={engineUnavailability}
                environmentId={environmentId}
                onOpenUsage={openBotSettings}
              />
            ) : sendBlocked ? null : !runtime.botReady ? (
              <p className="px-4 pb-3 text-center text-xs text-muted-foreground">
                {t("Connecting bot…")}
              </p>
            ) : runtime.bootstrapped && runtime.defaultProject === null ? (
              <p className="px-4 pb-3 text-center text-xs text-muted-foreground">
                {t("Your workspace is still loading. Try again in a moment.")}
              </p>
            ) : null}
          </div>
        </div>
      </SidebarInset>
    </ChatReplyContext>
  );
}
