import { useAtomValue } from "@effect/atom-react";
import { BotId, type EnvironmentId, type TurnId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { selectOpenBotInboxItems } from "../../botInbox";
import { canManageChannels, connectedChannelBinding } from "../../channelAccess";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadActivities } from "../../state/entities";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { environmentSnapshotAtom } from "../../state/shell";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import { openSettings } from "../../settingsDialogStore";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotActivityStatus } from "./BotActivityStatus";
import { BotApprovalPrompt } from "./BotApprovalPrompt";
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
import {
  channelOriginForAssistantMessage,
  isBotConversationWorking,
  visibleBotChatMessages,
} from "./botConversationPresentation";
import { resolveStickyBotEngine } from "./botEngineSelection";
import { BotPromptComposer } from "./BotPromptComposer";
import { buildBotStepMeters } from "./botStepMeter.logic";
import { ThreadErrorBanner } from "../chat/ThreadErrorBanner";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { PluginSearchResultCard } from "../chat/PluginSearchResultCard";
import { buildReplyPrompt, type MessageReplyTarget } from "../chat/MessageControls";
import { useOptionalReplyPlayback } from "../chat/ReplyPlaybackProvider";
import { useReplyPlaybackThread } from "~/lib/replyPlaybackThread";
import { BotVoiceCallButton, useVoiceCall } from "../voice/VoiceCall";
import { useBotPresence } from "./botPresence";
import { useRosterStore } from "./rosterStore";
import { useBotThreadRuntime } from "./useBotThreadRuntime";
import { useRosterPendingApproval } from "./useRosterPendingApproval";
import { deriveWorkLogEntries, pluginSearchResultForWorkEntry } from "../../session-logic";
import { activeThreadRuntimeWarning } from "./threadRuntimeWarning.logic";
import { ThreadRuntimeWarningBanner } from "./ThreadRuntimeWarningBanner";

const NO_ENVIRONMENT = "" as EnvironmentId;

export function BotThreadLanding({ botId }: { readonly botId: string }) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const channelSession = useEnvironmentSessionState(environmentId ?? ("" as EnvironmentId));
  const canManageChannelBindings = canManageChannels(channelSession.data);
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const bots = useRosterStore((state) => state.bots);
  const bot = bots.find((candidate) => candidate.id === botId);
  const [replyTarget, setReplyTarget] = useState<MessageReplyTarget | null>(null);
  const configuredEngine = bot?.engine ?? null;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const defaultSelection = useMemo(
    () => resolveAppModelSelectionState(settings, providers),
    [providers, settings],
  );
  const stickyEngine = useMemo(
    () =>
      resolveStickyBotEngine({
        engine: configuredEngine,
        instanceEntries,
        settings,
        providers,
        defaultSelection,
      }),
    [configuredEngine, defaultSelection, instanceEntries, providers, settings],
  );
  const runtime = useBotThreadRuntime(botId, stickyEngine);
  const approvalState = useRosterPendingApproval(runtime.linkedThreadRef);
  const activities = useThreadActivities(runtime.linkedThreadRef);
  const stepMeters = useMemo(() => buildBotStepMeters(activities), [activities]);
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
    if (!bot || bot.archivedAt !== null) {
      void navigate({ to: "/", replace: true });
      return;
    }
    useRosterStore.getState().selectBot(bot.id);
  }, [bot, navigate]);

  const working = isBotConversationWorking({
    sending: runtime.sending,
    respondingToUserInput: runtime.respondingRequestIds.length > 0,
    presence,
  });
  const messages = useMemo(
    () => visibleBotChatMessages(runtime.messages, working),
    [runtime.messages, working],
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

  if (!bot || bot.archivedAt !== null) return null;
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
  const delegations = runtime.linkedThreadRef
    ? (snapshot?.delegations.filter(
        (delegation) => delegation.parentThreadId === runtime.linkedThreadRef?.threadId,
      ) ?? [])
    : [];
  const currentPersonId = snapshot?.currentPersonId;
  const linkedThreadId = runtime.linkedThreadRef?.threadId;
  const channelApprovalFor = (messageIndex: number): ChannelApprovalTarget | null => {
    if (!canManageChannelBindings || !environmentId || !linkedThreadId) return null;
    const message = messages[messageIndex];
    const origin = channelOriginForAssistantMessage(messages, messageIndex);
    const binding = origin ? connectedChannelBinding(bot.channelBindings, origin.provider) : null;
    if (!message || !origin || !binding) return null;
    return {
      environmentId,
      botId: BotId.make(bot.id),
      threadId: linkedThreadId,
      origin,
      sent: binding.sentMessageIds.includes(message.id),
    };
  };
  return (
    <SidebarInset
      aria-label={`${bot.name} chat`}
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
            </div>
          </WorkspacePageHeader>
          <BotConversationScrollArea>
            {messages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12">
                <BotAvatarView avatar={bot.avatar} name={bot.name} className="size-14" />
                <h1 className="text-lg font-medium">Message {bot.name}</h1>
              </div>
            ) : (
              messages.map((message, messageIndex) =>
                message.role === "assistant" ? (
                  <AssistantMessageRow
                    key={message.id}
                    message={message}
                    author={bot}
                    testId="bot-provider-message"
                    cwd={runtime.defaultProject?.workspaceRoot}
                    threadRef={runtime.linkedThreadRef ?? undefined}
                    stepMeter={
                      message.turnId === null ? undefined : stepMeters.get(message.turnId)
                    }
                    pluginResults={
                      message.turnId === null ? undefined : pluginResultsByTurn.get(message.turnId)
                    }
                    currentPersonId={currentPersonId}
                    playback={replyPlayback}
                    playbackKey={playbackKey}
                    channelApproval={channelApprovalFor(messageIndex)}
                    onReply={replyTo}
                    onReactionChange={updateReaction}
                  />
                ) : (
                  <UserMessageRow
                    key={message.id}
                    message={message}
                    testId="bot-user-message"
                    replyLabel="you"
                    showChannelOrigin
                    environmentId={environmentId}
                    currentPersonId={currentPersonId}
                    onReply={replyTo}
                    onReactionChange={updateReaction}
                  />
                ),
              )
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
                </div>
              </div>
            ) : null}
            {delegations.map((delegation) => (
              <DelegationCard
                key={delegation.delegationId}
                delegation={delegation}
                childBot={
                  bots.find(
                    (candidate) =>
                      candidate.id === delegation.childBotId && candidate.archivedAt === null,
                  ) ?? null
                }
              />
            ))}
            {working ? <BotActivityStatus avatar={bot.avatar} name={bot.name} /> : null}
          </BotConversationScrollArea>
          <BotInboxAlertStack
            items={inboxItems}
            onOpenDetails={() => openSettings("inbox", null, environmentId)}
          />
          <ThreadRuntimeWarningBanner warning={runtimeWarning} />
          <ThreadErrorBanner
            error={
              inboxItems.some((item) => item.lastFailure === runtime.error) ? null : runtime.error
            }
            {...(runtime.canResume ? { onResume: () => void runtime.resume() } : {})}
            resuming={runtime.resuming}
          />
          <BotPromptComposer
            botName={bot.name}
            draftKey={bot.id}
            pendingActionSlot={
              pendingApproval ? (
                <BotApprovalPrompt
                  approval={pendingApproval}
                  pendingCount={approvalState.pendingCount}
                  responding={approvalState.responding}
                  error={approvalState.responseError}
                  onRespond={(decision) =>
                    approvalState.respond(pendingApproval.requestId, decision)
                  }
                />
              ) : null
            }
            disabled={
              pendingApproval !== null ||
              runtime.respondingRequestIds.length > 0 ||
              voiceCall.activeCall?.botId === bot.id ||
              voiceCall.startingBotId === bot.id ||
              stickyEngine === null ||
              !runtime.botReady ||
              !runtime.bootstrapped ||
              runtime.defaultProject === null
            }
            replyPreview={replyTarget}
            onCancelReply={() => setReplyTarget(null)}
            onSubmit={async (prompt, files) => {
              const sent = await runtime.send(buildReplyPrompt(replyTarget, prompt), files);
              if (sent) setReplyTarget(null);
              return sent;
            }}
          />
          {stickyEngine === null ? (
            <p className="px-4 pb-3 text-center text-xs text-muted-foreground">
              Enable a provider before you message this bot.
            </p>
          ) : !runtime.botReady ? (
            <p className="px-4 pb-3 text-center text-xs text-muted-foreground">Connecting bot…</p>
          ) : runtime.bootstrapped && runtime.defaultProject === null ? (
            <p className="px-4 pb-3 text-center text-xs text-muted-foreground">
              Add a project before you message a bot.
            </p>
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}
