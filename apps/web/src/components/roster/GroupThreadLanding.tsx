import { threadDelegations } from "@t3tools/client-runtime/delegation-presentation";
import { botChatTimeline } from "@t3tools/client-runtime/state/bot-chat-timeline";
import { pendingMemoryApprovals } from "@t3tools/client-runtime/durable-memory";
import { useAtomValue } from "@effect/atom-react";
import { presentThreadError } from "@t3tools/client-runtime/errors";
import { type EnvironmentId } from "@t3tools/contracts";
import { Fragment, useCallback, useEffect, useId, useMemo, useState } from "react";

import { selectOpenBotInboxItems } from "../../botInbox";
import { openSettings } from "../../settingsDialogStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentPeopleAtom } from "../../state/bots";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadActivities } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { environmentSnapshotAtom } from "../../state/shell";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { buildReplyPrompt, type MessageReplyTarget } from "../chat/MessageControls";
import { ConversationSeparator } from "../chat/ConversationSeparator";
import { useOptionalReplyPlayback } from "../chat/ReplyPlaybackProvider";
import { useReplyPlaybackThread } from "~/lib/replyPlaybackThread";
import { useI18n } from "~/i18n";
import { ProviderUnavailableNotice } from "../chat/ProviderUnavailableNotice";
import { ThreadErrorBanner } from "../chat/ThreadErrorBanner";
import { useOptionalVoiceCall } from "../voice/VoiceCall";
import { threadSilentRun } from "@t3tools/client-runtime/silent-run";
import { botActivityUpdate, BotActivityStatus } from "./BotActivityStatus";
import { deriveBotActivity } from "./botActivityStatus.logic";
import { BotApprovalPrompt } from "./BotApprovalPrompt";
import { MemoryApprovalPrompt } from "./MemoryApprovalPrompt";
import { BotUserInputPrompt } from "./BotUserInputPrompt";
import { BotInboxAlertStack } from "./BotInboxAlertStack";
import { BotAvatarView } from "./BotAvatarView";
import { BotConversationScrollArea } from "./BotConversationScrollArea";
import { DelegationCard } from "./DelegationCard";
import { GroupMemberStack } from "./GroupMemberStack";
import {
  buildBotConversationEntries,
  isBotConversationWorking,
  visibleBotChatMessages,
} from "./botConversationPresentation";
import { BotPromptComposer } from "./BotPromptComposer";
import {
  AssistantMessageRow,
  type MessageReplyHandler,
  UserMessageRow,
  useMessageReactionUpdater,
} from "./BotChatMessageRows";
import { useBotPromptMentionScope } from "./BotPromptMentions";
import { BotTurnFailureRow } from "./BotTurnFailureRow";
import { botEngineFailureContext, botEngineTakesDelegatedWork } from "./botEngineSelection";
import { buildBotStepMeters } from "./botStepMeter.logic";
import { useGroupPresence } from "./botPresence";
import { groupBotMembers, isCurrentGroupPerson } from "./roster.logic";
import { cn } from "../../lib/utils";
import { useMessageArrivals } from "./messageArrival";
import { useRosterStore } from "./rosterStore";
import { useGroupThreadRuntime } from "./useGroupThreadRuntime";
import { useBotEngineAvailability } from "./useBotEngineAvailability";
import { useLocalDay } from "./useLocalDay";
import { useRosterPendingApproval } from "./useRosterPendingApproval";
import { useEnableBotAutoReview } from "./useServerRoster";
import { activeThreadRuntimeWarning } from "./threadRuntimeWarning.logic";
import { ThreadRuntimeWarningBanner } from "./ThreadRuntimeWarningBanner";

const NO_ENVIRONMENT = "" as EnvironmentId;

export function resolveAvailableGroupBoss<T extends { readonly id: string }>(
  members: ReadonlyArray<T>,
  bossBotId: string | null,
): T | null {
  return members.find((bot) => bot.id === bossBotId) ?? null;
}

/** The bot a group draft goes to: the mentioned member, otherwise the boss. */
export function resolveGroupAddressedBot<T extends { readonly id: string }>(
  members: ReadonlyArray<T>,
  boss: T | null,
  addressedBotId: string | null,
): T | null {
  return members.find((bot) => bot.id === addressedBotId) ?? boss;
}

export function GroupThreadLanding({ groupId }: { readonly groupId: string }) {
  const { t, locale } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  const peopleIdentity = useAtomValue(
    environmentPeopleAtom((environmentId ?? "") as EnvironmentId),
  );
  const group = useRosterStore((state) =>
    state.groups.find((candidate) => candidate.id === groupId),
  );
  const bots = useRosterStore((state) => state.bots);
  const runtime = useGroupThreadRuntime(groupId);
  const mentionScope = useBotPromptMentionScope({
    environmentId,
    threadRef: runtime.linkedThreadRef,
    projectId: runtime.defaultProject?.id,
    cwd: runtime.defaultProject?.workspaceRoot,
  });
  const respondingBot = bots.find((bot) => bot.id === runtime.respondingBotId) ?? null;
  // Names the provider behind a failed reply, like a bot chat does.
  const respondingEngine = useBotEngineAvailability(respondingBot?.engine ?? null);
  const failureContext = botEngineFailureContext(
    respondingEngine.selection,
    respondingEngine.instanceEntries,
    runtime.failure?.unavailability,
  );
  const members = group
    ? groupBotMembers(group, bots).filter((bot) => bot.archivedAt === null)
    : [];
  const boss = group ? resolveAvailableGroupBoss(members, group.bossBotId) : null;
  // The boss answers a group message first, so its provider's skills label sent messages.
  const bossCatalog = useBotEngineAvailability(boss?.engine ?? null).catalog;
  // A mention sends the draft to that member, so the `$` and `/` pickers offer its provider's catalog.
  const [addressedBotId, setAddressedBotId] = useState<string | null>(null);
  const addressedBot = resolveGroupAddressedBot(members, boss, addressedBotId);
  const composerCatalog = useBotEngineAvailability(addressedBot?.engine ?? null).catalog;
  const noProviderNoticeId = useId();
  const replyPlayback = useOptionalReplyPlayback();
  const voiceCall = useOptionalVoiceCall();
  const [replyTarget, setReplyTarget] = useState<MessageReplyTarget | null>(null);
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
  const presence = useGroupPresence(groupId);
  const inboxQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
  const snapshot = useAtomValue(environmentSnapshotAtom(environmentId ?? NO_ENVIRONMENT));

  useEffect(() => {
    setReplyTarget(null);
  }, [groupId, runtime.linkedThreadRef?.environmentId, runtime.linkedThreadRef?.threadId]);

  const pendingApproval = approvalState.pendingApproval;
  const pendingUserInput = runtime.pendingUserInputs[0] ?? null;
  const waitingForUserInput =
    pendingUserInput !== null && !runtime.respondingRequestIds.includes(pendingUserInput.requestId);
  // Derived before the transcript is built: the visible set depends on whether a turn is
  // still open, so an intermediate answer from the active turn stays behind the status.
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
  const arrivedMessageIds = useMessageArrivals(
    { owner: groupId, thread: runtime.linkedThreadRef?.threadId ?? null },
    messages.map((message) => message.id),
  );
  const playbackKey = useReplyPlaybackThread({
    environmentId: group ? (runtime.linkedThreadRef?.environmentId ?? environmentId) : null,
    threadId: group ? runtime.linkedThreadRef?.threadId : null,
    messages: group ? messages : [],
    mediaBlocked: Boolean(voiceCall?.activeCall || voiceCall?.startingBotId),
  });
  const updateReaction = useMessageReactionUpdater(runtime.linkedThreadRef);
  const replyTo = useCallback<MessageReplyHandler>(
    (messageId, label, text) => setReplyTarget({ messageId, label, text }),
    [],
  );

  if (!group) return null;
  const currentPersonId = peopleIdentity.current?.id;
  const activeBot = members.find((bot) => bot.id === runtime.respondingBotId) ?? boss;
  const inboxItems = selectOpenBotInboxItems(
    inboxQuery.data?.inbox ?? [],
    new Set(members.map((bot) => bot.id)),
  );
  const { delegations, waitingOnChildren } =
    runtime.linkedThreadRef && snapshot
      ? threadDelegations(snapshot.delegations, runtime.linkedThreadRef.threadId)
      : { delegations: [], waitingOnChildren: false };
  const timeline = botChatTimeline({
    messages: entries.map((entry) => ({
      id: entry.message.id,
      turnId: entry.message.turnId,
      createdAt: entry.message.createdAt,
      entry,
    })),
    delegations,
  });
  const activeBotById = (id: string) =>
    bots.find((candidate) => candidate.id === id && candidate.archivedAt === null) ?? null;
  return (
    <SidebarInset
      aria-label={t("{name} group chat", { name: group.name })}
      className="h-dvh min-h-0 overflow-hidden bg-background text-foreground"
      data-testid="group-thread-landing"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          <div className="flex min-w-0 items-center gap-2">
            <GroupMemberStack group={group} bots={bots} />
            <span className="truncate text-sm font-medium">{group.name}</span>
          </div>
        </WorkspacePageHeader>
        <BotConversationScrollArea
          followKey={messages.findLast((message) => message.role === "user")?.id}
        >
          {timeline.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12">
              <div className="flex -space-x-3">
                {members.slice(0, 3).map((bot) => (
                  <BotAvatarView
                    key={bot.id}
                    avatar={bot.avatar}
                    name={bot.name}
                    className="size-14 ring-4 ring-background"
                  />
                ))}
              </div>
              <h1 className="text-lg font-medium">
                {boss ? t("Message {name}", { name: group.name }) : t("Group boss unavailable")}
              </h1>
            </div>
          ) : (
            timeline.map((item) => {
              if (item._tag === "Delegation") {
                return (
                  <DelegationCard
                    key={item.key}
                    variant="group"
                    delegation={item.delegation}
                    delegations={delegations}
                    childBot={activeBotById(item.delegation.childBotId)}
                    parentBot={activeBotById(item.delegation.parentBotId)}
                  />
                );
              }
              if (item._tag !== "Message") return null;
              const { message, separator, startsGroup } = item.message.entry;
              if (message.role === "assistant") {
                const respondingBot = message.respondingBotId
                  ? members.find((bot) => bot.id === message.respondingBotId)
                  : boss;
                return (
                  <Fragment key={message.id}>
                    {separator ? <ConversationSeparator label={separator} /> : null}
                    <AssistantMessageRow
                      message={message}
                      arrived={arrivedMessageIds.has(message.id)}
                      author={respondingBot ?? null}
                      testId="group-provider-message"
                      startsGroup={startsGroup}
                      cwd={runtime.defaultProject?.workspaceRoot}
                      threadRef={runtime.linkedThreadRef ?? undefined}
                      stepMeter={
                        message.turnId === null ? undefined : stepMeters.get(message.turnId)
                      }
                      pluginResults={undefined}
                      currentPersonId={currentPersonId}
                      playback={replyPlayback}
                      playbackKey={playbackKey}
                      channelApproval={null}
                      onReply={replyTo}
                      onReactionChange={updateReaction}
                    />
                  </Fragment>
                );
              }
              const current = isCurrentGroupPerson(
                message.authorPersonId,
                currentPersonId,
                peopleIdentity.host?.id,
              );
              return (
                <Fragment key={message.id}>
                  {separator ? <ConversationSeparator label={separator} /> : null}
                  <UserMessageRow
                    message={message}
                    arrived={arrivedMessageIds.has(message.id)}
                    testId="group-user-message"
                    startsGroup={startsGroup}
                    replyLabel={current ? "you" : "participant"}
                    showChannelOrigin={false}
                    skills={bossCatalog?.skills}
                    environmentId={environmentId}
                    currentPersonId={currentPersonId}
                    onReply={replyTo}
                    onReactionChange={updateReaction}
                  />
                </Fragment>
              );
            })
          )}
          {!working && runtime.turnFailure && messages.at(-1)?.role === "user" ? (
            <BotTurnFailureRow
              botName={activeBot?.name ?? group.name}
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
          threadKey={`${runtime.linkedThreadRef?.environmentId ?? environmentId ?? "unknown"}:${runtime.linkedThreadRef?.threadId ?? group.id}`}
          error={
            inboxItems.some((item) => item.lastFailure === runtime.error) ? null : runtime.error
          }
          context={failureContext}
          environmentId={environmentId}
          {...(runtime.canResume ? { onResume: () => void runtime.resume() } : {})}
          resuming={runtime.resuming}
        />
        {!runtime.providerAvailable ? (
          <ProviderUnavailableNotice
            id={noProviderNoticeId}
            className="mx-auto mt-2 w-[min(46rem,calc(100%-2rem))]"
            presentation={{
              title: t("No provider is connected"),
              description: t("Connect a provider in Settings > Providers so this group can reply."),
              action: "providers",
            }}
            environmentId={environmentId}
          />
        ) : null}
        {boss === null ? (
          <div className="px-4 py-2 text-sm text-muted-foreground" role="status">
            {t("Choose an active group boss in the group sidebar.")}
          </div>
        ) : null}
        <BotPromptComposer
          mentionScope={mentionScope}
          commandCatalog={composerCatalog}
          onAddressedBotChange={setAddressedBotId}
          botName={group.name}
          draftKey={`group:${group.id}`}
          busy={working && pendingApproval === null}
          activitySlot={
            working && activeBot && !waitingForUserInput && pendingApproval === null ? (
              <BotActivityStatus
                name={activeBot.name}
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
                  const answered = await approvalState.respond(pendingApproval.requestId, decision);
                  if (answered && decision === "acceptAlways" && boss) {
                    await enableAutoReview(boss.id);
                  }
                  return answered;
                }}
              />
            ) : waitingForUserInput ? (
              <BotUserInputPrompt
                pendingUserInputs={runtime.pendingUserInputs}
                respondingRequestIds={runtime.respondingRequestIds}
                answers={runtime.pendingUserInputAnswers}
                questionIndex={runtime.pendingUserInputQuestionIndex}
                onToggleOption={runtime.selectPendingUserInputOption}
                onSelectSingleOption={runtime.selectPendingUserInputOption}
                onAdvance={runtime.advancePendingUserInput}
                threadRef={runtime.linkedThreadRef}
                askingBot={activeBot ?? null}
              />
            ) : memoryApprovals.length > 0 && runtime.linkedThreadRef ? (
              <MemoryApprovalPrompt
                threadRef={runtime.linkedThreadRef}
                approvals={memoryApprovals}
                currentBotId={activeBot?.id ?? null}
              />
            ) : null
          }
          quietSurface={pendingApproval !== null || pendingUserInput !== null}
          {...(waitingForUserInput ? { placeholder: t("Write a custom answer…") } : {})}
          disabled={
            pendingApproval !== null ||
            runtime.respondingRequestIds.length > 0 ||
            !runtime.groupReady ||
            !runtime.bootstrapped ||
            runtime.defaultProject === null ||
            (!waitingForUserInput && !runtime.providerAvailable)
          }
          mentionBots={members.map((bot) => ({
            id: bot.id,
            name: bot.name,
            title: bot.title,
            canTakeWork: botEngineTakesDelegatedWork(bot.engine, respondingEngine.instanceEntries),
          }))}
          replyPreview={replyTarget}
          onCancelReply={() => setReplyTarget(null)}
          sendBlockedDescriptionId={
            runtime.providerAvailable || waitingForUserInput ? undefined : noProviderNoticeId
          }
          onSubmit={async (prompt, files, respondingBotId) => {
            const sent = await runtime.send(
              buildReplyPrompt(replyTarget, prompt),
              files,
              respondingBotId,
            );
            if (sent) setReplyTarget(null);
            return sent;
          }}
        />
      </div>
    </SidebarInset>
  );
}
