import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { selectOpenBotInboxItems } from "../../botInbox";
import { openSettings } from "../../settingsDialogStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentPeopleAtom } from "../../state/bots";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SidebarInset } from "../ui/sidebar";
import ChatMarkdown from "../ChatMarkdown";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ThreadErrorBanner } from "../chat/ThreadErrorBanner";
import { BotActivityStatus } from "./BotActivityStatus";
import { BotInboxAlertStack } from "./BotInboxAlertStack";
import { BotAvatarView } from "./BotAvatarView";
import { BotConversationScrollArea } from "./BotConversationScrollArea";
import { GroupMemberStack } from "./GroupMemberStack";
import { visibleBotChatMessages } from "./botConversationPresentation";
import { BotPromptComposer } from "./BotPromptComposer";
import { useGroupPresence } from "./botPresence";
import { groupBotMembers, isCurrentGroupPerson } from "./roster.logic";
import { useRosterStore } from "./rosterStore";
import { useGroupThreadRuntime } from "./useGroupThreadRuntime";

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
  const presence = useGroupPresence(groupId);
  const inboxQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );

  if (!group) return null;
  const members = groupBotMembers(group, bots).filter((bot) => bot.archivedAt === null);
  const boss = resolveAvailableGroupBoss(members, group.bossBotId);
  const working = runtime.sending || presence === "working";
  const messages = visibleBotChatMessages(runtime.messages, working);
  const activeBot = members.find((bot) => bot.id === runtime.respondingBotId) ?? boss;
  const inboxItems = selectOpenBotInboxItems(
    inboxQuery.data?.inbox ?? [],
    new Set(members.map((bot) => bot.id)),
  );

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
                const respondingBot =
                  members.find((bot) => bot.id === message.respondingBotId) ?? boss;
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
                    </div>
                  );
                }
                return (
                  <div
                    key={message.id}
                    className="flex items-start gap-3"
                    data-testid="group-provider-message"
                  >
                    <BotAvatarView
                      avatar={respondingBot.avatar}
                      name={respondingBot.name}
                      className="mt-0.5 size-7 shrink-0"
                    />
                    <div className="min-w-0 max-w-[85%]">
                      <div className="text-sm font-medium">{respondingBot.name}</div>
                      <ChatMarkdown
                        className="mt-1"
                        cwd={runtime.defaultProject?.workspaceRoot}
                        text={message.text}
                        threadRef={runtime.linkedThreadRef ?? undefined}
                      />
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
                  className={current ? "flex justify-end" : "flex justify-start"}
                  data-testid="group-user-message"
                >
                  <div className="max-w-[78%]">
                    {!current ? (
                      <div className="mb-1 text-xs font-medium text-muted-foreground">
                        {message.authorDisplayName ??
                          peopleIdentity.host?.displayName ??
                          "Paired person"}
                      </div>
                    ) : null}
                    <div className="rounded-2xl bg-foreground/10 px-3.5 py-2 text-sm leading-6">
                      <p className="whitespace-pre-wrap">{message.text}</p>
                    </div>
                  </div>
                </div>
              );
            })
          )}
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
          disabled={
            runtime.sending ||
            !runtime.groupReady ||
            !runtime.bootstrapped ||
            runtime.defaultProject === null ||
            boss === null
          }
          mentionBots={members.map((bot) => ({ id: bot.id, name: bot.name }))}
          modelPicker={null}
          onSubmit={runtime.send}
        />
      </div>
    </SidebarInset>
  );
}
