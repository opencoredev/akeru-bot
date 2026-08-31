import { useAtomValue } from "@effect/atom-react";
import { BotId, type BotEngine } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { selectOpenBotInboxItems } from "../../botInbox";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { botEnvironment } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { openSettings } from "../../settingsDialogStore";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import ChatMarkdown from "../ChatMarkdown";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotActivityStatus } from "./BotActivityStatus";
import { BotInboxAlertStack } from "./BotInboxAlertStack";
import { BotAvatarView } from "./BotAvatarView";
import { BotConversationScrollArea } from "./BotConversationScrollArea";
import { visibleBotChatMessages } from "./botConversationPresentation";
import { resolveStickyBotEngine } from "./botEngineSelection";
import { ThreadErrorBanner } from "../chat/ThreadErrorBanner";
import { BotVoiceCallButton, useVoiceCall } from "../voice/VoiceCall";
import { BotPromptComposer } from "./BotPromptComposer";
import { useBotPresence } from "./botPresence";
import { useRosterStore } from "./rosterStore";
import { useBotThreadRuntime } from "./useBotThreadRuntime";

export function BotThreadLanding({ botId }: { readonly botId: string }) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const updateBot = useAtomCommand(botEnvironment.update, { reportFailure: false });
  const bot = useRosterStore((state) => state.bots.find((candidate) => candidate.id === botId));
  const [pendingEngine, setPendingEngine] = useState<BotEngine | null>(null);
  const [modelUpdatePending, setModelUpdatePending] = useState(false);
  const configuredEngine = pendingEngine ?? bot?.engine ?? null;
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
  const activeEntry = useMemo(
    () => instanceEntries.find((entry) => entry.instanceId === stickyEngine?.instanceId) ?? null,
    [instanceEntries, stickyEngine?.instanceId],
  );
  const activeModel = stickyEngine?.model ?? null;
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );
  const effectiveModelSelection = stickyEngine;
  const runtime = useBotThreadRuntime(botId, effectiveModelSelection);
  const voiceCall = useVoiceCall();
  const presence = useBotPresence(botId);
  const inboxQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );

  useEffect(() => {
    if (
      pendingEngine &&
      bot?.engine?.provider === pendingEngine.provider &&
      bot.engine.model === pendingEngine.model
    ) {
      setPendingEngine(null);
    }
  }, [bot?.engine, pendingEngine]);

  useEffect(() => {
    if (!bot || bot.archivedAt !== null) {
      void navigate({ to: "/", replace: true });
      return;
    }
    useRosterStore.getState().selectBot(bot.id);
  }, [bot, navigate]);

  if (!bot || bot.archivedAt !== null) return null;
  const working = runtime.sending || presence === "working";
  const messages = visibleBotChatMessages(runtime.messages, working);
  const inboxItems = selectOpenBotInboxItems(inboxQuery.data?.inbox ?? [], new Set([bot.id]));

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
              messages.map((message) =>
                message.role === "assistant" ? (
                  <div
                    key={message.id}
                    className="flex items-start gap-3"
                    data-testid="bot-provider-message"
                  >
                    <BotAvatarView
                      avatar={bot.avatar}
                      name={bot.name}
                      className="mt-0.5 size-7 shrink-0"
                    />
                    <div className="min-w-0 max-w-[85%]">
                      <div className="text-sm font-medium">{bot.name}</div>
                      <ChatMarkdown
                        className="mt-1"
                        cwd={runtime.defaultProject?.workspaceRoot}
                        text={message.text}
                        threadRef={runtime.linkedThreadRef ?? undefined}
                      />
                    </div>
                  </div>
                ) : (
                  <div key={message.id} className="flex justify-end" data-testid="bot-user-message">
                    <div className="max-w-[78%] rounded-2xl bg-foreground/10 px-3.5 py-2 text-sm leading-6">
                      <p className="whitespace-pre-wrap">{message.text}</p>
                      {message.attachments?.length ? (
                        <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
                          {message.attachments.map((attachment) => (
                            <span
                              key={attachment.id}
                              className="rounded-full bg-background/60 px-2 py-0.5 text-xs text-muted-foreground"
                            >
                              {attachment.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ),
              )
            )}
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
            disabled={
              runtime.sending ||
              voiceCall.activeCall?.botId === bot.id ||
              voiceCall.startingBotId === bot.id ||
              modelUpdatePending ||
              effectiveModelSelection === null ||
              !runtime.botReady ||
              !runtime.bootstrapped ||
              runtime.defaultProject === null
            }
            modelPicker={
              environmentId && activeEntry && activeModel
                ? {
                    activeInstanceId: activeEntry.instanceId,
                    model: activeModel,
                    instanceEntries,
                    modelOptionsByInstance,
                    onChange: (instanceId, model) => {
                      const nextEngine = { provider: instanceId, model };
                      setPendingEngine(nextEngine);
                      setModelUpdatePending(true);
                      void updateBot({
                        environmentId,
                        input: {
                          botId: BotId.make(bot.id),
                          engine: nextEngine,
                        },
                      }).then((result) => {
                        setModelUpdatePending(false);
                        if (result._tag === "Failure") {
                          setPendingEngine(null);
                          toastManager.add({ type: "error", title: "Could not change model" });
                        }
                      });
                    },
                  }
                : null
            }
            onSubmit={runtime.send}
          />
          {effectiveModelSelection === null ? (
            <p className="px-4 pb-3 text-center text-xs text-muted-foreground">
              Enable a provider before you message this bot.
            </p>
          ) : modelUpdatePending ? (
            <p className="px-4 pb-3 text-center text-xs text-muted-foreground">Changing model…</p>
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
