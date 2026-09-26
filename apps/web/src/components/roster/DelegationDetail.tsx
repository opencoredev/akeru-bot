import type {
  AkeruDelegationAccessGrant,
  AkeruDelegationRecord,
  AkeruDelegationState,
} from "@t3tools/contracts";
import { presentDelegation } from "@t3tools/client-runtime/delegation-presentation";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { MessageKey, TranslationParams } from "@t3tools/client-runtime/i18n";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { useI18n } from "../../i18n";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadMessages, useThreadShell } from "../../state/entities";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { BotAvatarView } from "./BotAvatarView";
import { useRosterStore } from "./rosterStore";
import type { Bot } from "./types";

type Translate = (key: MessageKey, params?: TranslationParams) => string;

function runtimeModeLabel(mode: AkeruDelegationAccessGrant["runtimeMode"], t: Translate): string {
  switch (mode) {
    case "approval-required":
      return t("approval required");
    case "auto-accept-edits":
      return t("auto-accept edits");
    case "auto":
      return t("automatic approvals");
    case "full-access":
      return t("full access");
  }
}

export function delegationStateLabel(state: AkeruDelegationState, t: Translate): string {
  switch (state) {
    case "queued":
      return t("queued");
    case "running":
      return t("running");
    case "blocked":
      return t("blocked");
    case "failed":
      return t("failed");
    case "canceled":
      return t("canceled");
    case "completed":
      return t("completed");
  }
}

// Sandbox, tool, memory scope, and approval ceiling values are identifiers and stay raw.
export function formatDelegationAccess(access: AkeruDelegationAccessGrant, t: Translate): string {
  return [
    runtimeModeLabel(access.runtimeMode, t),
    access.sandbox === null ? t("no sandbox") : t("{sandbox} sandbox", { sandbox: access.sandbox }),
    t("tools: {tools}", { tools: access.allowedToolIds.join(", ") || t("none") }),
    t("memory: {scopes}", { scopes: access.memoryScopes.join(", ") || t("none") }),
    t("MCP servers: {count}", { count: access.enabledMcpServerIds.length }),
    access.hasUserComputer ? t("user computer") : t("no user computer"),
    access.approvalCeiling === "none"
      ? t("no approvals")
      : t("approval ceiling: {ceiling}", { ceiling: access.approvalCeiling }),
  ].join(" · ");
}

/**
 * Read-only view of one piece of delegated work: the brief, the access it was
 * given, and the child's chat so far. Mount it only while open, because it
 * subscribes to the child thread's messages.
 */
export function DelegationDetail({
  delegation,
  childBot,
  parentBot,
  onOpenChange,
}: {
  readonly delegation: AkeruDelegationRecord;
  readonly childBot: Bot | null;
  readonly parentBot: Bot | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const presentation = presentDelegation(delegation);
  const childThreadRef = useMemo(
    () =>
      environmentId && presentation.childThreadId
        ? scopeThreadRef(environmentId, presentation.childThreadId)
        : null,
    [environmentId, presentation.childThreadId],
  );
  const childThread = useThreadShell(childThreadRef);
  const messages = useThreadMessages(childThreadRef);
  const activeChildBot = childBot?.archivedAt === null ? childBot : null;
  const childName = activeChildBot?.name ?? t("Unknown bot");
  const canOpen = activeChildBot !== null && childThread !== null && environmentId !== null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl" data-testid="delegation-detail">
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-2">
            <BotAvatarView
              avatar={activeChildBot?.avatar ?? { kind: "dither", seed: delegation.childBotId }}
              name={childName}
              className="size-7 shrink-0"
            />
            <DialogTitle className="min-w-0 truncate">
              {t("Work by {name}", { name: childName })}
            </DialogTitle>
          </div>
          <DialogDescription>{delegationStateLabel(presentation.state, t)}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4 text-sm">
          <section>
            <h3 className="text-xs font-medium text-muted-foreground">{t("Task")}</h3>
            <p className="mt-1 whitespace-pre-wrap leading-6">{delegation.task}</p>
          </section>
          <section>
            <h3 className="text-xs font-medium text-muted-foreground">{t("Expected result")}</h3>
            <p className="mt-1 whitespace-pre-wrap leading-6">{delegation.expectedResult}</p>
          </section>
          <section>
            <h3 className="text-xs font-medium text-muted-foreground">{t("Access")}</h3>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {formatDelegationAccess(delegation.access, t)}
            </p>
          </section>
          <section aria-label={t("{name} chat", { name: childName })}>
            {messages.length === 0 ? (
              <p className="text-muted-foreground">{t("No messages yet")}</p>
            ) : (
              <ol className="flex flex-col gap-3">
                {messages.map((message) => (
                  <li key={message.id} data-role={message.role}>
                    <div className="text-xs font-medium text-muted-foreground">
                      {message.role === "assistant" ? childName : (parentBot?.name ?? t("Unknown bot"))}
                    </div>
                    <ChatMarkdown
                      className="mt-0.5"
                      cwd={undefined}
                      text={message.text}
                      threadRef={childThreadRef ?? undefined}
                      isStreaming={message.streaming}
                    />
                  </li>
                ))}
              </ol>
            )}
          </section>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="ghost"
            aria-label={t("Open {name} chat", { name: childName })}
            disabled={!canOpen}
            onClick={() => {
              if (!canOpen) return;
              useRosterStore
                .getState()
                .recordChatPath(activeChildBot.id, `/${environmentId}/${childThread.id}`);
              onOpenChange(false);
              void navigate({ to: "/bots/$botId", params: { botId: activeChildBot.id } });
            }}
          >
            {t("Open chat")}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
