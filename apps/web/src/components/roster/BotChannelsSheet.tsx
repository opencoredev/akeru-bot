import { useAtomValue } from "@effect/atom-react";
import {
  BotId,
  type ChannelConnectionId,
  type ChannelConnectionProfile,
  type ChannelProvider,
  type EnvironmentId,
  type OrchestrationBot,
  type ProjectId,
} from "@t3tools/contracts";
import {
  canChangeChannelProject,
  channelBindingNeedsProject,
  channelPickerProjectId,
  channelRepairAction,
} from "@t3tools/client-runtime/channel-presentation";
import { defaultProjectIdForBot } from "@t3tools/shared/channelProject";
import type * as Cause from "effect/Cause";
import { useState } from "react";

import { isChannelIdentityConflict, resolveChannelSettingsAccess } from "../../channelAccess";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import { botEnvironment, environmentBotsAtom } from "../../state/bots";
import { environmentSnapshotAtom } from "../../state/shell";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { openSettings } from "../../settingsDialogStore";
import { useAtomCommand } from "../../state/use-atom-command";
import { ChannelProjectSelect } from "../settings/ChannelProjectSelect";
import { channelSettingsTarget } from "../settings/channelProviderMeta";
import {
  ChannelRepairButton,
  ChannelStatusBadge,
  ChannelStatusNotice,
  channelWebhookUrl,
} from "../settings/ChannelStatus";
import { Button } from "../ui/button";
import { Sheet, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import type { Bot } from "./types";

const NO_ENVIRONMENT = "" as EnvironmentId;

const providerLabel = (provider: ChannelProvider) =>
  provider === "imessage"
    ? "Photon"
    : provider === "whatsapp"
      ? "Meta Cloud API"
      : provider === "telegram"
        ? "Telegram Bot API"
        : provider === "slack"
          ? "Slack Socket Mode"
          : "Discord Gateway";

const assignedBotForConnection = (
  connectionId: ChannelConnectionId,
  bots: ReadonlyArray<Pick<OrchestrationBot, "id" | "name" | "channelBindings">>,
) =>
  bots.find((candidate) =>
    (candidate.channelBindings ?? []).some((binding) => binding.connectionId === connectionId),
  );

export function BotChannelsSheet({
  bot,
  open,
  onOpenChange,
}: {
  readonly bot: Bot;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  const targetEnvironmentId = environmentId ?? NO_ENVIRONMENT;
  const session = useEnvironmentSessionState(targetEnvironmentId);
  const bots = useAtomValue(environmentBotsAtom(targetEnvironmentId));
  const snapshot = useAtomValue(environmentSnapshotAtom(targetEnvironmentId));
  const connections = usePrimarySettings((settings) => settings.channelConnections);
  const attach = useAtomCommand(botEnvironment.channels.attach, { reportFailure: false });
  const disconnect = useAtomCommand(botEnvironment.channels.disconnect, {
    reportFailure: false,
  });
  const detach = useAtomCommand(botEnvironment.channels.detach, { reportFailure: false });
  const reconnect = useAtomCommand(botEnvironment.channels.reconnect, {
    reportFailure: false,
  });
  const changeProject = useAtomCommand(botEnvironment.channels.changeProject, {
    reportFailure: false,
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pickedProjects, setPickedProjects] = useState<Record<string, ProjectId>>({});
  const liveProjects = snapshot?.projects ?? [];
  const projectHint = snapshot ? defaultProjectIdForBot(snapshot, BotId.make(bot.id)) : null;
  const channelState = (connection: ChannelConnectionProfile) => {
    const owner = assignedBotForConnection(connection.id, bots);
    const binding = owner?.channelBindings?.find(
      (candidate) => candidate.connectionId === connection.id,
    );
    const ownedByCurrentBot = owner?.id === bot.id;
    const needsProject =
      ownedByCurrentBot && binding ? channelBindingNeedsProject(binding, liveProjects) : false;
    const projectId = channelPickerProjectId({
      selected: pickedProjects[connection.id],
      binding: ownedByCurrentBot ? binding : undefined,
      hint: projectHint,
      liveProjects,
    });
    const canMove =
      ownedByCurrentBot &&
      binding !== undefined &&
      canChangeChannelProject(binding, projectId, liveProjects);
    const repairAction =
      ownedByCurrentBot && binding ? channelRepairAction(binding, liveProjects) : "none";
    return { owner, binding, ownedByCurrentBot, needsProject, projectId, canMove, repairAction };
  };
  const access = resolveChannelSettingsAccess({
    isPending: session.isPending,
    session: session.data,
  });

  const run = async (
    connection: ChannelConnectionProfile,
    command: () => Promise<
      | { readonly _tag: "Success" }
      | { readonly _tag: "Failure"; readonly cause?: Cause.Cause<unknown> }
    >,
  ) => {
    setBusyId(connection.id);
    const result = await command();
    setBusyId(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: t("Could not update channel"),
        ...(isChannelIdentityConflict(result)
          ? {
              description: t(
                "Another bot already uses this account. Unassign it there, then connect again.",
              ),
            }
          : {}),
      });
    }
  };

  const moveToProject = (connection: ChannelConnectionProfile) => {
    const { projectId, canMove } = channelState(connection);
    if (!environmentId || !canMove || projectId === null) return;
    void run(connection, () =>
      changeProject({
        environmentId,
        input: { botId: BotId.make(bot.id), provider: connection.provider, projectId },
      }),
    );
  };

  const connect = (connection: ChannelConnectionProfile) => {
    const { owner, projectId } = channelState(connection);
    if (!environmentId || owner || projectId === null) return;
    void run(connection, () =>
      attach({
        environmentId,
        input: {
          botId: BotId.make(bot.id),
          connectionId: connection.id,
          provider: connection.provider,
          projectId,
        },
      }),
    );
  };

  const channelInput = (connection: ChannelConnectionProfile) => ({
    botId: BotId.make(bot.id),
    provider: connection.provider,
  });

  const unassign = async (connection: ChannelConnectionProfile) => {
    if (!environmentId) return;
    setBusyId(connection.id);
    const result = await detach({
      environmentId,
      input: { botId: BotId.make(bot.id), provider: connection.provider },
    });
    setBusyId(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: t("Could not unassign channel") });
    }
  };

  const openChannelSettings = (provider?: ChannelProvider) => {
    onOpenChange(false);
    openSettings("channels", provider ? channelSettingsTarget(provider) : null, environmentId);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="w-[min(94vw,28rem)]">
        <SheetHeader>
          <SheetTitle>{t("{name} channels", { name: bot.name })}</SheetTitle>
        </SheetHeader>
        <SheetPanel className="space-y-2 px-3">
          {environmentId === null ? (
            <div className="py-8 text-sm text-muted-foreground">
              {t("Connect an environment first.")}
            </div>
          ) : access === "pending" ? (
            <div className="flex justify-center py-8">
              <Spinner aria-label={t("Loading channel access")} />
            </div>
          ) : access === "denied" ? (
            <div className="py-8 text-sm text-muted-foreground">
              {t("This client does not have permission to manage channels.")}
            </div>
          ) : connections.length === 0 ? (
            <div className="space-y-3 py-4">
              <p className="text-sm text-muted-foreground">
                {t("Set up a channel connection first.")}
              </p>
              <Button onClick={() => openChannelSettings()}>{t("Set up channels")}</Button>
            </div>
          ) : (
            <>
              {connections.map((connection) => {
                const {
                  owner,
                  binding,
                  ownedByCurrentBot,
                  needsProject,
                  projectId,
                  canMove,
                  repairAction,
                } = channelState(connection);
                return (
                  <div
                    key={connection.id}
                    className="flex flex-col gap-3 rounded-xl border px-3 py-2.5"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="truncate text-sm font-medium">{connection.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {providerLabel(connection.provider)}
                        {(binding?.externalIdentity ?? connection.externalIdentity)
                          ? ` · ${binding?.externalIdentity ?? connection.externalIdentity}`
                          : ""}
                      </div>
                      <ChannelStatusNotice
                        binding={binding}
                        needsProject={needsProject}
                        webhookUrl={channelWebhookUrl(connection)}
                      />
                      <ChannelStatusBadge
                        binding={binding}
                        ownerName={owner?.name}
                        needsProject={needsProject}
                      />
                    </div>
                    {!owner || ownedByCurrentBot ? (
                      <ChannelProjectSelect
                        projects={liveProjects}
                        value={projectId}
                        onChange={(next) =>
                          setPickedProjects((current) => ({ ...current, [connection.id]: next }))
                        }
                        label={t("Project for {name}", { name: connection.name })}
                        disabled={busyId !== null}
                      />
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      {connection.managementUrl && repairAction !== "check-delivery" ? (
                        <Button
                          variant="outline"
                          render={
                            <a href={connection.managementUrl} target="_blank" rel="noreferrer" />
                          }
                        >
                          {t("Open provider")}
                        </Button>
                      ) : null}
                      {ownedByCurrentBot ? (
                        <Button
                          variant="outline"
                          disabled={busyId !== null}
                          onClick={() => void unassign(connection)}
                        >
                          {t("Unassign")}
                        </Button>
                      ) : null}
                      {canMove && repairAction !== "choose-project" ? (
                        <Button
                          variant="outline"
                          disabled={busyId !== null}
                          onClick={() => moveToProject(connection)}
                        >
                          {t("Move to this project")}
                        </Button>
                      ) : null}
                      {ownedByCurrentBot && binding?.status === "connected" ? (
                        <Button
                          variant="outline"
                          disabled={busyId !== null}
                          onClick={() =>
                            environmentId &&
                            void run(connection, () =>
                              disconnect({ environmentId, input: channelInput(connection) }),
                            )
                          }
                        >
                          {t("Disconnect")}
                        </Button>
                      ) : null}
                      {owner && !ownedByCurrentBot ? (
                        <Button disabled>{t("Assigned")}</Button>
                      ) : !binding ? (
                        <Button
                          disabled={busyId !== null || projectId === null}
                          onClick={() => connect(connection)}
                        >
                          {t("Connect")}
                        </Button>
                      ) : (
                        <ChannelRepairButton
                          action={repairAction}
                          status={binding.status}
                          disabled={
                            busyId !== null || (repairAction === "choose-project" && !canMove)
                          }
                          managementUrl={connection.managementUrl}
                          onRepair={(action) => {
                            if (action === "choose-project") return moveToProject(connection);
                            // Replacing credentials needs the full setup form in Settings.
                            if (action === "update-credentials")
                              return openChannelSettings(connection.provider);
                            if (!environmentId) return;
                            void run(connection, () =>
                              reconnect({ environmentId, input: channelInput(connection) }),
                            );
                          }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
              <Button variant="outline" onClick={() => openChannelSettings()}>
                {t("Manage connections")}
              </Button>
            </>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
