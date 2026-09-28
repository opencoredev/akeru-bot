import { threadDelegations } from "@t3tools/client-runtime/delegation-presentation";
import { botChatTimeline } from "@t3tools/client-runtime/state/bot-chat-timeline";
import { pendingMemoryApprovals } from "@t3tools/client-runtime/durable-memory";
import { useAtomValue } from "@effect/atom-react";
import { presentThreadError } from "@t3tools/client-runtime/errors";
import {
  BotId,
  type EnvironmentId,
  type RoutineRun,
  type RoutineRunId,
  type TurnId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, Clock3Icon } from "lucide-react";

import { cn } from "~/lib/utils";

import { selectOpenBotInboxItems } from "../../botInbox";
import { canManageChannels, connectedChannelBinding } from "../../channelAccess";
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
import { threadSilentRun } from "@t3tools/client-runtime/silent-run";
import { botActivityUpdate, BotActivityStatus } from "./BotActivityStatus";
import { deriveBotActivity } from "./botActivityStatus.logic";
import { BotApprovalPrompt } from "./BotApprovalPrompt";
import { MemoryApprovalPrompt } from "./MemoryApprovalPrompt";
import { BotInboxAlertStack } from "./BotInboxAlertStack";
import { BotAvatarView } from "./BotAvatarView";
import { BotConversationScrollArea } from "./BotConversationScrollArea";
import { DelegationCard } from "./DelegationCard";
import {
  AssistantMessageRow,
  type ChannelApprovalTarget,
  type MessageReplyHandler,
  UserMessageRow,
  useMessageReactionUpdater,
} from "./BotChatMessageRows";
import { channelOriginForAssistantMessage } from "@t3tools/client-runtime/channel-origin-presentation";
import {
  buildBotConversationEntries,
  isBotConversationWorking,
  visibleBotChatMessages,
} from "./botConversationPresentation";
import { botEngineFailureContext } from "./botEngineSelection";
import { BotTurnFailureRow } from "./BotTurnFailureRow";
import { useBotEngineAvailability } from "./useBotEngineAvailability";
import { BotPromptComposer } from "./BotPromptComposer";
import { useBotPromptMentionScope } from "./BotPromptMentions";
import { buildBotStepMeters } from "./botStepMeter.logic";
import { ThreadErrorBanner } from "../chat/ThreadErrorBanner";
import { ProviderUnavailableNotice } from "../chat/ProviderUnavailableNotice";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { OpenComputerAction } from "../computer/OpenComputerAction";
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
import { useEnableBotAutoReview } from "./useServerRoster";
import { deriveWorkLogEntries, pluginSearchResultForWorkEntry } from "../../session-logic";
import { activeThreadRuntimeWarning } from "./threadRuntimeWarning.logic";
import {
  deriveRoutineReceipts,
  mergeRoutineRunHistory,
  type RoutineReceipt,
} from "./routineReceipts";
import { resolveRoutedBot } from "./rosterRouteSelection";
import { ThreadRuntimeWarningBanner } from "./ThreadRuntimeWarningBanner";
import { ChatActionsMenu, useMarkChatVisited } from "../chat/ChatActionsMenu";

function RoutineReceiptRow({
  receipt,
  onOpenRoutines,
}: {
  readonly receipt: RoutineReceipt;
  readonly onOpenRoutines?: () => void;
}) {
  const { t, formatDate } = useI18n();
  const Icon =
    receipt.tone === "error"
      ? CircleAlertIcon
      : receipt.tone === "success"
        ? CircleCheckIcon
        : Clock3Icon;
  const error = receipt.tone === "error";
  const opensRoutines = !receipt.archived && !!onOpenRoutines;
  const Row = opensRoutines ? "button" : "div";
  return (
    <Row
      {...(opensRoutines
        ? {
            type: "button" as const,
            "aria-label": t("{text}. Open Routines", { text: receipt.text }),
          }
        : {})}
      className={cn(
        "mx-auto flex w-full max-w-3xl items-start gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground",
        opensRoutines &&
          "outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        error && "bg-destructive/8 text-destructive",
        error && opensRoutines && "hover:bg-destructive/12 hover:text-destructive",
      )}
      data-testid="routine-receipt"
      onClick={opensRoutines ? onOpenRoutines : undefined}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-normal break-words text-left leading-5">
        {receipt.text}
      </span>
      <time className="shrink-0 text-[11px] text-muted-foreground/60" dateTime={receipt.createdAt}>
        {formatDate(new Date(receipt.createdAt), { hour: "numeric", minute: "2-digit" })}
      </time>
      {opensRoutines ? (
        <ChevronRightIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 opacity-60" />
      ) : null}
    </Row>
  );
}

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
  const channelSession = useEnvironmentSessionState(environmentId ?? ("" as EnvironmentId));
  const canManageChannelBindings = canManageChannels(channelSession.data);
  const bots = useRosterStore((state) => state.bots);
  const rosterEnvironmentId = useRosterStore((state) => state.environmentId);
  const routedBot = resolveRoutedBot(environmentId, rosterEnvironmentId, bots, botId);
  const bot = routedBot.status === "available" ? routedBot.bot : undefined;
  const [replyTarget, setReplyTarget] = useState<MessageReplyTarget | null>(null);
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
  );
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
  const today = useLocalDay();
  const todayLabel = t("Today");
  const entries = useMemo(
    () => buildBotConversationEntries(messages, today, todayLabel, locale),
    [messages, today, todayLabel, locale],
  );
  const routineRunHistory = useEnvironmentQuery(
    runtime.linkedThreadRef
      ? serverEnvironment.routineThreadRuns({
          environmentId: runtime.linkedThreadRef.environmentId,
          input: { threadId: runtime.linkedThreadRef.threadId },
        })
      : null,
  );
  const threadId = runtime.linkedThreadRef?.threadId ?? null;
  const [routineHistory, setRoutineHistory] = useState<{
    threadId: string | null;
    runs: RoutineRun[];
    requestedCursor: RoutineRunId | null;
    loadedCursor: RoutineRunId | null;
    nextCursor: RoutineRunId | null;
  }>({ threadId: null, runs: [], requestedCursor: null, loadedCursor: null, nextCursor: null });
  const currentHistory =
    routineHistory.threadId === threadId
      ? routineHistory
      : { threadId, runs: [], requestedCursor: null, loadedCursor: null, nextCursor: null };
  const olderRoutineRuns = useEnvironmentQuery(
    runtime.linkedThreadRef && currentHistory.requestedCursor
      ? serverEnvironment.routineThreadRuns({
          environmentId: runtime.linkedThreadRef.environmentId,
          input: {
            threadId: runtime.linkedThreadRef.threadId,
            beforeRunId: currentHistory.requestedCursor,
          },
        })
      : null,
  );
  useEffect(() => {
    setRoutineHistory({
      threadId,
      runs: [],
      requestedCursor: null,
      loadedCursor: null,
      nextCursor: null,
    });
  }, [threadId]);
  useEffect(() => {
    const page = routineRunHistory.data;
    if (!page || !threadId) return;
    setRoutineHistory((previous) =>
      previous.threadId === threadId
        ? {
            ...previous,
            runs: mergeRoutineRunHistory(previous.runs, page.runs),
            nextCursor: previous.loadedCursor === null ? page.nextCursor : previous.nextCursor,
          }
        : previous,
    );
  }, [routineRunHistory.data, threadId]);
  useEffect(() => {
    const page = olderRoutineRuns.data;
    const cursor = currentHistory.requestedCursor;
    if (!page || !cursor || currentHistory.loadedCursor === cursor) return;
    setRoutineHistory((previous) =>
      previous.threadId === threadId && previous.requestedCursor === cursor
        ? {
            ...previous,
            runs: mergeRoutineRunHistory(previous.runs, page.runs),
            loadedCursor: cursor,
            nextCursor: page.nextCursor,
          }
        : previous,
    );
  }, [
    currentHistory.loadedCursor,
    currentHistory.requestedCursor,
    olderRoutineRuns.data,
    threadId,
  ]);
  const nextRoutineCursor =
    currentHistory.loadedCursor === null
      ? (routineRunHistory.data?.nextCursor ?? null)
      : currentHistory.nextCursor;
  const routineRunRevision = useMemo(() => {
    const threadId = runtime.linkedThreadRef?.threadId;
    if (!threadId) return null;
    const routineIds = [...(snapshot?.routines ?? []), ...(snapshot?.routineReceiptSources ?? [])]
      .filter((routine) => routine.targetThreadId === threadId)
      .map((routine) => routine.id)
      .toSorted();
    const relevantIds = new Set(routineIds);
    const runs = (snapshot?.routineRuns ?? [])
      .filter((run) => relevantIds.has(run.routineId))
      .map((run) => [run.id, run.updatedAt] as const)
      .toSorted(([left], [right]) => left.localeCompare(right));
    return JSON.stringify([routineIds, runs]);
  }, [
    runtime.linkedThreadRef?.threadId,
    snapshot?.routines,
    snapshot?.routineReceiptSources,
    snapshot?.routineRuns,
  ]);
  const observedRoutineRevision = useRef<{
    threadId: string | null;
    revision: string | null;
  }>({ threadId: null, revision: null });
  useEffect(() => {
    const threadId = runtime.linkedThreadRef?.threadId ?? null;
    const previous = observedRoutineRevision.current;
    observedRoutineRevision.current = { threadId, revision: routineRunRevision };
    if (threadId === previous.threadId && routineRunRevision !== previous.revision) {
      routineRunHistory.refresh();
    }
  }, [runtime.linkedThreadRef?.threadId, routineRunRevision, routineRunHistory.refresh]);
  const routineReceipts = useMemo(
    () =>
      runtime.linkedThreadRef
        ? deriveRoutineReceipts(
            runtime.linkedThreadRef.threadId,
            [...(snapshot?.routines ?? []), ...(snapshot?.routineReceiptSources ?? [])],
            mergeRoutineRunHistory(currentHistory.runs, snapshot?.routineRuns ?? []),
            { t },
          )
        : [],
    [
      runtime.linkedThreadRef,
      snapshot?.routines,
      snapshot?.routineReceiptSources,
      snapshot?.routineRuns,
      currentHistory.runs,
      t,
    ],
  );
  const { delegations, waitingOnChildren } = useMemo(
    () =>
      runtime.linkedThreadRef && snapshot
        ? threadDelegations(snapshot.delegations, runtime.linkedThreadRef.threadId)
        : { delegations: [], waitingOnChildren: false },
    [runtime.linkedThreadRef, snapshot],
  );
  // Each message row carries the index it had in `messages`, because the merge
  // reorders it away from that position and a row must not go looking for itself.
  const timelineItems = useMemo(
    () =>
      botChatTimeline({
        messages: entries.map((entry) => ({
          id: entry.message.id,
          turnId: entry.message.turnId,
          createdAt: entry.message.createdAt,
          entry,
        })),
        receipts: routineReceipts,
        delegations,
      }),
    [entries, routineReceipts, delegations],
  );
  const arrivedMessageIds = useMessageArrivals(
    { owner: botId, thread: runtime.linkedThreadRef?.threadId ?? null },
    messages.map((message) => message.id),
  );
  const available = bot?.archivedAt === null;
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
    return (
      <SidebarInset
        aria-label={t("Loading bot…")}
        className="h-dvh min-h-0 items-center justify-center overflow-hidden bg-background text-muted-foreground"
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

  return (
    <SidebarInset
      aria-label={t("{name} chat", { name: bot.name })}
      className="h-dvh min-h-0 overflow-hidden bg-background text-foreground"
      data-testid="bot-thread-landing"
    >
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <WorkspacePageHeader className="border-b border-border">
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
            {nextRoutineCursor ? (
              <button
                type="button"
                className="mx-auto my-3 block rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                disabled={olderRoutineRuns.isPending}
                onClick={() => {
                  if (currentHistory.requestedCursor === nextRoutineCursor) {
                    olderRoutineRuns.refresh();
                  } else {
                    setRoutineHistory((previous) => ({
                      ...previous,
                      requestedCursor: nextRoutineCursor,
                    }));
                  }
                }}
              >
                {olderRoutineRuns.isPending
                  ? t("Loading older routine notes…")
                  : olderRoutineRuns.error
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
                  {item._tag === "Receipt" ? (
                    <RoutineReceiptRow
                      receipt={item.receipt}
                      {...(onOpenRoutines ? { onOpenRoutines } : {})}
                    />
                  ) : item._tag === "Delegation" ? (
                    <DelegationCard
                      delegation={item.delegation}
                      delegations={delegations}
                      childBot={activeBot(item.delegation.childBotId)}
                      parentBot={activeBot(item.delegation.parentBotId)}
                    />
                  ) : (
                    (() => {
                      const { message, separator, startsGroup } = item.message.entry;
                      const startsAfterReceipt =
                        timelineItems[timelineIndex - 1]?._tag === "Receipt";
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
                                message.turnId === null ? undefined : stepMeters.get(message.turnId)
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
                    questionIndex={runtime.pendingUserInputQuestionIndex}
                    onToggleOption={runtime.selectPendingUserInputOption}
                    onSelectSingleOption={runtime.selectPendingUserInputOption}
                    onAdvance={() => {
                      void runtime.advancePendingUserInput();
                    }}
                  />
                  <div className="mt-2">
                    <OpenComputerAction threadRef={runtime.linkedThreadRef} bot={bot} />
                  </div>
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
          <ThreadErrorBanner
            threadKey={`${runtime.linkedThreadRef?.environmentId ?? environmentId ?? "unknown"}:${runtime.linkedThreadRef?.threadId ?? bot.id}`}
            error={
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
          {sendBlocked && engineUnavailability ? (
            <ProviderUnavailableNotice
              id={engineNoticeId}
              className="mx-auto mt-2 w-[min(46rem,calc(100%-2rem))]"
              presentation={engineUnavailability}
              environmentId={environmentId}
              onOpenUsage={openBotSettings}
            />
          ) : null}
          <BotPromptComposer
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
            onSubmit={async (prompt, files) => {
              const sent = await runtime.send(buildReplyPrompt(replyTarget, prompt), files);
              if (sent) setReplyTarget(null);
              return sent;
            }}
          />
          {sendBlocked ? null : !runtime.botReady ? (
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
  );
}
