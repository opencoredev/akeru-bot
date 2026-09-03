import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type MessageId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { selectOpenBotInboxItems } from "../../botInbox";
import { openSettings } from "../../settingsDialogStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentPeopleAtom } from "../../state/bots";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadActivities } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { environmentSnapshotAtom } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import ChatMarkdown from "../ChatMarkdown";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  buildReplyPrompt,
  MessageControls,
  type MessageReactionOption,
  type MessageReplyTarget,
  selectedReactionForPerson,
} from "../chat/MessageControls";
import { MessageReactions } from "../chat/MessageReactions";
import { ThreadErrorBanner } from "../chat/ThreadErrorBanner";
import { BotActivityStatus } from "./BotActivityStatus";
import { BotApprovalPrompt } from "./BotApprovalPrompt";
import { BotUserInputPrompt } from "./BotUserInputPrompt";
import { BotInboxAlertStack } from "./BotInboxAlertStack";
import { BotAvatarView } from "./BotAvatarView";
import { BotConversationScrollArea } from "./BotConversationScrollArea";
import { DelegationCard } from "./DelegationCard";
import { GroupMemberStack } from "./GroupMemberStack";
import { visibleBotChatMessages } from "./botConversationPresentation";
import { BotPromptComposer } from "./BotPromptComposer";
import { BotMessageAttachments } from "./BotMessageAttachments";
import { BotStepMeter } from "./BotStepMeter";
import { buildBotStepMeters } from "./botStepMeter.logic";
import { useGroupPresence } from "./botPresence";
import { groupBotMembers, isCurrentGroupPerson } from "./roster.logic";
import { useRosterStore } from "./rosterStore";
import { useGroupThreadRuntime } from "./useGroupThreadRuntime";
import { useRosterPendingApproval } from "./useRosterPendingApproval";

const NO_ENVIRONMENT = "" as EnvironmentId;

export function resolveAvailableGroupBoss<T extends { readonly id: string }>(
  members: ReadonlyArray<T>,
  bossBotId: string | null,
): T | null {
  return members.find((bot) => bot.id === bossBotId) ?? null;
}

export function GroupThreadLanding({ groupId }: { readonly groupId: string }) {
  const environmentId = usePrimaryEnvironmentId();
  const peopleIdentity = useAtomValue(
    environmentPeopleAtom((environmentId ?? "") as EnvironmentId),
  );
  const group = useRosterStore((state) =>
    state.groups.find((candidate) => candidate.id === groupId),
  );
  const bots = useRosterStore((state) => state.bots);
  const runtime = useGroupThreadRuntime(groupId);
  const setMessageReaction = useAtomCommand(threadEnvironment.setMessageReaction, {
    reportFailure: false,
  });
  const [replyTarget, setReplyTarget] = useState<MessageReplyTarget | null>(null);
  const approvalState = useRosterPendingApproval(runtime.linkedThreadRef);
  const activities = useThreadActivities(runtime.linkedThreadRef);
  const stepMeters = useMemo(() => buildBotStepMeters(activities), [activities]);
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

  if (!group) return null;
  const members = groupBotMembers(group, bots).filter((bot) => bot.archivedAt === null);
  const boss = resolveAvailableGroupBoss(members, group.bossBotId);
  const working =
    runtime.sending || runtime.respondingRequestIds.length > 0 || presence === "working";
  const messages = visibleBotChatMessages(runtime.messages);
  const pendingApproval = approvalState.pendingApproval;
  const pendingUserInput = runtime.pendingUserInputs[0] ?? null;
  const activeBot = members.find((bot) => bot.id === runtime.respondingBotId) ?? boss;
  const inboxItems = selectOpenBotInboxItems(
    inboxQuery.data?.inbox ?? [],
    new Set(members.map((bot) => bot.id)),
  );
  const delegations = runtime.linkedThreadRef
    ? (snapshot?.delegations.filter(
        (delegation) => delegation.parentThreadId === runtime.linkedThreadRef?.threadId,
      ) ?? [])
    : [];
  const updateReaction = async (
    messageId: MessageId,
    current: MessageReactionOption | null,
    next: MessageReactionOption | null,
  ) => {
    const threadRef = runtime.linkedThreadRef;
    if (!threadRef) return;
    const dispatch = (emoji: MessageReactionOption, present: boolean) =>
      setMessageReaction({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          messageId,
          emoji,
          present,
        },
      });
    if (current && current !== next) {
      const removed = await dispatch(current, false);
      if (removed._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not update reaction" });
        return;
      }
    }
    if (next) {
      const added = await dispatch(next, true);
      if (added._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not update reaction" });
      }
    }
  };

  return (
    <SidebarInset
      aria-label={`${group.name} group thread`}
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
        <BotConversationScrollArea>
          {messages.length === 0 ? (
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
                {boss ? `Message ${group.name}` : "Group boss unavailable"}
              </h1>
            </div>
          ) : (
            messages.map((message) => {
              if (message.role === "assistant") {
                const respondingBot = message.respondingBotId
                  ? members.find((bot) => bot.id === message.respondingBotId)
                  : boss;
                if (!respondingBot) {
                  return (
                    <div
                      key={message.id}
                      className="max-w-[85%]"
                      data-testid="group-provider-message"
                    >
                      <div className="text-sm font-medium">Unavailable bot</div>
                      <ChatMarkdown
                        className="mt-1"
                        cwd={runtime.defaultProject?.workspaceRoot}
                        text={message.text}
                        threadRef={runtime.linkedThreadRef ?? undefined}
                      />
                      <div className="mt-1">
                        <MessageControls
                          copyText={message.text || "Attachment"}
                          onReply={() =>
                            setReplyTarget({
                              messageId: message.id,
                              label: "Unavailable bot",
                              text: message.text || "Attachment",
                            })
                          }
                        />
                      </div>
                    </div>
                  );
                }
                return (
                  <div
                    key={message.id}
                    className="group/message flex items-start gap-3"
                    data-testid="group-provider-message"
                  >
                    <BotAvatarView
                      avatar={respondingBot.avatar}
                      name={respondingBot.name}
                      className="mt-0.5 size-7 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{respondingBot.name}</div>
                      <BotStepMeter
                        meter={message.turnId === null ? undefined : stepMeters.get(message.turnId)}
                      />
                      <ChatMarkdown
                        className="mt-1"
                        cwd={runtime.defaultProject?.workspaceRoot}
                        text={message.text}
                        threadRef={runtime.linkedThreadRef ?? undefined}
                      />
                      <div className="mt-1 flex opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 max-md:opacity-100">
                        <MessageControls
                          copyText={message.text || "Attachment"}
                          selectedReaction={selectedReactionForPerson(
                            message.reactions,
                            peopleIdentity.current?.id,
                          )}
                          onReply={() =>
                            setReplyTarget({
                              messageId: message.id,
                              label: respondingBot.name,
                              text: message.text || "Attachment",
                            })
                          }
                          onReactionChange={(next) =>
                            void updateReaction(
                              message.id,
                              selectedReactionForPerson(
                                message.reactions,
                                peopleIdentity.current?.id,
                              ),
                              next,
                            )
                          }
                        />
                      </div>
                      <MessageReactions reactions={message.reactions ?? []} />
                    </div>
                  </div>
                );
              }
              const current = isCurrentGroupPerson(
                message.authorPersonId,
                peopleIdentity.current?.id,
                peopleIdentity.host?.id,
              );
              return (
                <div
                  key={message.id}
                  className="group/message flex items-end justify-end gap-1"
                  data-testid="group-user-message"
                >
                  <div className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 max-md:opacity-100">
                    <MessageControls
                      align="end"
                      copyText={
                        message.text ||
                        message.attachments?.map((attachment) => attachment.name).join(", ") ||
                        "Attachment"
                      }
                      selectedReaction={selectedReactionForPerson(
                        message.reactions,
                        peopleIdentity.current?.id,
                      )}
                      onReply={() =>
                        setReplyTarget({
                          messageId: message.id,
                          label: current ? "you" : "participant",
                          text:
                            message.text ||
                            message.attachments?.map((attachment) => attachment.name).join(", ") ||
                            "Attachment",
                        })
                      }
                      onReactionChange={(next: MessageReactionOption | null) =>
                        void updateReaction(
                          message.id,
                          selectedReactionForPerson(message.reactions, peopleIdentity.current?.id),
                          next,
                        )
                      }
                    />
                  </div>
                  <div className="flex max-w-[78%] flex-col items-end">
                    <div className="w-full rounded-2xl bg-foreground/10 px-3.5 py-2 text-sm leading-6">
                      {message.text ? <p className="whitespace-pre-wrap">{message.text}</p> : null}
                      {message.attachments?.length ? (
                        <div className={message.text ? "mt-2" : undefined}>
                          <BotMessageAttachments
                            attachments={message.attachments}
                            environmentId={environmentId ?? NO_ENVIRONMENT}
                          />
                        </div>
                      ) : null}
                    </div>
                    <MessageReactions reactions={message.reactions ?? []} />
                  </div>
                </div>
              );
            })
          )}
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
          {working && activeBot ? (
            <BotActivityStatus avatar={activeBot.avatar} name={activeBot.name} />
          ) : null}
        </BotConversationScrollArea>
        <BotInboxAlertStack
          items={inboxItems}
          onOpenDetails={() => openSettings("inbox", null, environmentId)}
        />
        <ThreadErrorBanner
          error={
            inboxItems.some((item) => item.lastFailure === runtime.error) ? null : runtime.error
          }
        />
        {boss === null ? (
          <div className="px-4 py-2 text-sm text-muted-foreground" role="status">
            Choose an active group boss in the group sidebar.
          </div>
        ) : null}
        <BotPromptComposer
          botName={group.name}
          draftKey={`group:${group.id}`}
          pendingActionSlot={
            pendingApproval ? (
              <BotApprovalPrompt
                approval={pendingApproval}
                pendingCount={approvalState.pendingCount}
                responding={approvalState.responding}
                error={approvalState.responseError}
                onRespond={(decision) => approvalState.respond(pendingApproval.requestId, decision)}
              />
            ) : pendingUserInput ? (
              <BotUserInputPrompt
                pendingUserInputs={runtime.pendingUserInputs}
                respondingRequestIds={runtime.respondingRequestIds}
                answers={runtime.pendingUserInputAnswers}
                questionIndex={runtime.pendingUserInputQuestionIndex}
                onToggleOption={runtime.selectPendingUserInputOption}
                onSelectSingleOption={runtime.selectPendingUserInputOption}
                onAdvance={runtime.advancePendingUserInput}
              />
            ) : null
          }
          {...(pendingUserInput ? { placeholder: "Write a custom answer..." } : {})}
          disabled={
            runtime.sending ||
            pendingApproval !== null ||
            runtime.respondingRequestIds.length > 0 ||
            !runtime.groupReady ||
            !runtime.bootstrapped ||
            runtime.defaultProject === null ||
            boss === null
          }
          mentionBots={members.map((bot) => ({ id: bot.id, name: bot.name }))}
          replyPreview={replyTarget}
          onCancelReply={() => setReplyTarget(null)}
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
