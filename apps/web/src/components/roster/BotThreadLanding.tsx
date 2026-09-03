import { useAtomValue } from "@effect/atom-react";
import {
  BotId,
  type ChannelMessageOrigin,
  type EnvironmentId,
  type MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { selectOpenBotInboxItems } from "../../botInbox";
import { canManageChannels, connectedChannelBinding } from "../../channelAccess";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { botEnvironment } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadActivities } from "../../state/entities";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { environmentSnapshotAtom } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { openSettings } from "../../settingsDialogStore";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import ChatMarkdown from "../ChatMarkdown";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotActivityStatus } from "./BotActivityStatus";
import { BotApprovalPrompt } from "./BotApprovalPrompt";
import { BotUserInputPrompt } from "./BotUserInputPrompt";
import { BotInboxAlertStack } from "./BotInboxAlertStack";
import { BotAvatarView } from "./BotAvatarView";
import { BotConversationScrollArea } from "./BotConversationScrollArea";
import { DelegationCard } from "./DelegationCard";
import {
  channelOriginForAssistantMessage,
  channelProviderLabel,
  isBotConversationWorking,
  visibleBotChatMessages,
} from "./botConversationPresentation";
import { resolveStickyBotEngine } from "./botEngineSelection";
import { BotPromptComposer } from "./BotPromptComposer";
import { BotMessageAttachments } from "./BotMessageAttachments";
import { BotStepMeter } from "./BotStepMeter";
import { buildBotStepMeters } from "./botStepMeter.logic";
import { ThreadErrorBanner } from "../chat/ThreadErrorBanner";
import {
  buildReplyPrompt,
  MessageControls,
  type MessageReactionOption,
  type MessageReplyTarget,
  selectedReactionForPerson,
} from "../chat/MessageControls";
import { MessageReactions } from "../chat/MessageReactions";
import { BotVoiceCallButton, useVoiceCall } from "../voice/VoiceCall";
import { useBotPresence } from "./botPresence";
import { useRosterStore } from "./rosterStore";
import { useBotThreadRuntime } from "./useBotThreadRuntime";
import { useRosterPendingApproval } from "./useRosterPendingApproval";

const NO_ENVIRONMENT = "" as EnvironmentId;

function ChannelSendApproval({
  environmentId,
  botId,
  origin,
  threadId,
  messageId,
  sent,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly origin: ChannelMessageOrigin;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly sent: boolean;
}) {
  const send = useAtomCommand(botEnvironment.channels.send, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const delivered = sent || submitted;
  const label = channelProviderLabel(origin.provider);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
      <span className="min-w-0 flex-1 text-muted-foreground">
        {delivered ? `Sent to ${label}` : `Send this reply to ${label}?`}
      </span>
      {!delivered ? (
        <Button
          size="xs"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void send({
              environmentId,
              input: { botId, threadId, messageId },
            }).then((result) => {
              setBusy(false);
              if (result._tag === "Failure") {
                toastManager.add({ type: "error", title: `Could not send to ${label}` });
              } else {
                setSubmitted(true);
              }
            });
          }}
        >
          {busy ? "Sending" : "Send"}
        </Button>
      ) : null}
    </div>
  );
}

export function BotThreadLanding({ botId }: { readonly botId: string }) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const channelSession = useEnvironmentSessionState(environmentId ?? ("" as EnvironmentId));
  const canManageChannelBindings = canManageChannels(channelSession.data);
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const setMessageReaction = useAtomCommand(threadEnvironment.setMessageReaction, {
    reportFailure: false,
  });
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
  const voiceCall = useVoiceCall();
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

  if (!bot || bot.archivedAt !== null) return null;
  const working = isBotConversationWorking({
    sending: runtime.sending,
    respondingToUserInput: runtime.respondingRequestIds.length > 0,
    presence,
  });
  const messages = visibleBotChatMessages(runtime.messages, working);
  const pendingApproval = approvalState.pendingApproval;
  const pendingUserInput = runtime.pendingUserInputs[0] ?? null;
  const inboxItems = selectOpenBotInboxItems(inboxQuery.data?.inbox ?? [], new Set([bot.id]));
  const delegations = runtime.linkedThreadRef
    ? (snapshot?.delegations.filter(
        (delegation) => delegation.parentThreadId === runtime.linkedThreadRef?.threadId,
      ) ?? [])
    : [];
  const currentPersonId = snapshot?.currentPersonId;
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
      aria-label={`${bot.name} thread`}
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
                  <div
                    key={message.id}
                    className="group/message flex items-start gap-3"
                    data-testid="bot-provider-message"
                  >
                    <BotAvatarView
                      avatar={bot.avatar}
                      name={bot.name}
                      className="mt-0.5 size-7 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{bot.name}</div>
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
                            currentPersonId,
                          )}
                          onReply={() =>
                            setReplyTarget({
                              messageId: message.id,
                              label: bot.name,
                              text: message.text || "Attachment",
                            })
                          }
                          onReactionChange={(next) =>
                            void updateReaction(
                              message.id,
                              selectedReactionForPerson(message.reactions, currentPersonId),
                              next,
                            )
                          }
                        />
                      </div>
                      <MessageReactions reactions={message.reactions ?? []} />
                      {canManageChannelBindings && environmentId && runtime.linkedThreadRef
                        ? (() => {
                            const origin = channelOriginForAssistantMessage(messages, messageIndex);
                            const binding = origin
                              ? connectedChannelBinding(bot.channelBindings, origin.provider)
                              : undefined;
                            return origin && binding ? (
                              <ChannelSendApproval
                                environmentId={environmentId}
                                botId={BotId.make(bot.id)}
                                origin={origin}
                                threadId={runtime.linkedThreadRef.threadId}
                                messageId={message.id}
                                sent={binding.sentMessageIds.includes(message.id)}
                              />
                            ) : null;
                          })()
                        : null}
                    </div>
                  </div>
                ) : (
                  <div
                    key={message.id}
                    className="group/message flex items-end justify-end gap-1"
                    data-testid="bot-user-message"
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
                          currentPersonId,
                        )}
                        onReply={() =>
                          setReplyTarget({
                            messageId: message.id,
                            label: "you",
                            text:
                              message.text ||
                              message.attachments
                                ?.map((attachment) => attachment.name)
                                .join(", ") ||
                              "Attachment",
                          })
                        }
                        onReactionChange={(next) =>
                          void updateReaction(
                            message.id,
                            selectedReactionForPerson(message.reactions, currentPersonId),
                            next,
                          )
                        }
                      />
                    </div>
                    <div className="flex max-w-[78%] flex-col items-end">
                      <div className="w-full rounded-2xl bg-foreground/10 px-3.5 py-2 text-sm leading-6">
                        {message.text ? (
                          <p className="whitespace-pre-wrap">{message.text}</p>
                        ) : null}
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
                ),
              )
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
            {working ? <BotActivityStatus avatar={bot.avatar} name={bot.name} /> : null}
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
