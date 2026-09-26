import { useAtomValue } from "@effect/atom-react";
import {
  BotId,
  EnvironmentId,
  McpServerId,
  ProjectId,
  RoutineId,
  RoutineRunId,
  SkillAssignmentId,
  SkillId,
} from "@t3tools/contracts";
import {
  botRoutinesView,
  toRoutineSchedule,
  type RoutineAdapterDraft,
} from "@t3tools/client-runtime/routines";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { BotThreadLanding } from "../components/roster/BotThreadLanding";
import { BotDetailsPanel } from "../components/roster/BotDetailsPanel";
import { routineDelegateOptions } from "../components/roster/botEngineSelection";
import { useBotThreadRef } from "../components/roster/useBotThreadRef";
import { resolveRoutedBot } from "../components/roster/rosterRouteSelection";
import { useRosterStore } from "../components/roster/rosterStore";
import { toastManager } from "../components/ui/toast";
import { useI18n } from "../i18n";
import { randomUUID } from "../lib/utils";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { botRoutePanelKeys } from "./botRoutePanelKeys";
import { usePrimaryEnvironmentId } from "../state/environments";
import { routineEnvironment } from "../state/routines";
import { primaryServerProvidersAtom } from "../state/server";
import { environmentSnapshotAtom } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";

const NO_ENVIRONMENT = "" as EnvironmentId;

function BotThreadRouteView() {
  const { t } = useI18n();
  const { botId } = Route.useParams();
  const panelKeys = botRoutePanelKeys(botId);
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const draftRoutine = useAtomCommand(routineEnvironment.draft, { reportFailure: false });
  const approveRoutine = useAtomCommand(routineEnvironment.approve, { reportFailure: false });
  const enableRoutine = useAtomCommand(routineEnvironment.enable, { reportFailure: false });
  const pauseRoutine = useAtomCommand(routineEnvironment.pause, { reportFailure: false });
  const runRoutine = useAtomCommand(routineEnvironment.run, { reportFailure: false });
  const deleteRoutine = useAtomCommand(routineEnvironment.delete, { reportFailure: false });
  const assignSkill = useAtomCommand(routineEnvironment.assignSkill, { reportFailure: false });
  const snapshot = useAtomValue(environmentSnapshotAtom(environmentId ?? NO_ENVIRONMENT));
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [busyRoutineId, setBusyRoutineId] = useState<string | null>(null);
  const [routinePanelRequest, setRoutinePanelRequest] = useState(0);
  /*
   * The roster store is not scoped to the active environment, so a bot found by
   * id alone can still belong to the environment we just left. Judging the id
   * only once the store mirrors this environment keeps the panel from showing
   * one environment's bot while its saves address another.
   */
  const bots = useRosterStore((state) => state.bots);
  const rosterEnvironmentId = useRosterStore((state) => state.environmentId);
  const routedBot = resolveRoutedBot(environmentId, rosterEnvironmentId, bots, botId);
  const bot = routedBot.status === "available" ? routedBot.bot : null;
  const threadRef = useBotThreadRef(botId);
  // A routine can hand its work to any other active bot in this environment.
  // Bots whose provider cannot take handed-off work stay listed but disabled.
  const delegateOptions = useMemo(
    () =>
      bot ? routineDelegateOptions(bot.id, bots, deriveProviderInstanceEntries(providers)) : [],
    [bot, bots, providers],
  );
  const botAssignments = useMemo(
    () => (snapshot?.skillAssignments ?? []).filter((assignment) => assignment.botId === botId),
    [botId, snapshot?.skillAssignments],
  );
  const providerSkills = useMemo(
    () =>
      providers
        .filter((provider) => provider.instanceId === bot?.engine?.provider)
        .flatMap((provider) => provider.skills)
        .filter((skill) => skill.enabled),
    [bot?.engine?.provider, providers],
  );
  const skillOptions = useMemo(
    () =>
      [
        ...new Set([
          ...botAssignments.map((assignment) => assignment.name),
          ...providerSkills.map((skill) => skill.name),
        ]),
      ].sort(),
    [botAssignments, providerSkills],
  );
  const routinesView = useMemo(() => botRoutinesView(snapshot, botId), [botId, snapshot]);
  const routines = routinesView.kind === "ready" ? routinesView.routines : [];

  const requireSuccess = (result: { readonly _tag: string }, message: string) => {
    if (result._tag === "Success") return;
    toastManager.add({ type: "error", title: message });
    throw new Error(message);
  };

  const withBusy = async (routineId: string, action: () => Promise<void>) => {
    setBusyRoutineId(routineId);
    try {
      await action();
    } finally {
      setBusyRoutineId(null);
    }
  };
  const startBusy = (routineId: string, action: () => Promise<void>) => {
    void withBusy(routineId, action).catch(() => undefined);
  };

  const skillAssignmentIds = async (draft: RoutineAdapterDraft) => {
    if (!environmentId || !bot) throw new Error("The routine environment is unavailable.");
    const ids: SkillAssignmentId[] = [];
    for (const name of draft.skills) {
      const existing = botAssignments.find((assignment) => assignment.name === name);
      if (existing) {
        ids.push(existing.id);
        continue;
      }
      const assignmentId = SkillAssignmentId.make(randomUUID());
      const metadata = providerSkills.find((skill) => skill.name === name);
      const result = await assignSkill({
        environmentId,
        input: {
          assignmentId,
          botId: BotId.make(bot.id),
          skillId: SkillId.make(name),
          name,
          description: metadata?.description ?? metadata?.shortDescription ?? null,
          createdAt: new Date().toISOString(),
        },
      });
      requireSuccess(result, t("Could not assign {name}", { name }));
      ids.push(assignmentId);
    }
    return ids;
  };

  const routineDefinition = async (draft: RoutineAdapterDraft) => ({
    botId: BotId.make(botId),
    job: draft.name,
    procedure: draft.prompt,
    schedule: toRoutineSchedule(draft),
    timezone: draft.schedule.timezone,
    skillAssignmentIds: await skillAssignmentIds(draft),
    connectorDependencies: draft.connectors.flatMap((name) => {
      const server = snapshot?.mcpServers?.find((candidate) => candidate.name === name);
      return server ? [McpServerId.make(server.id)] : [];
    }),
    projectId: ProjectId.make(draft.projectId),
    sandbox: draft.sandbox,
    approvalPolicy: draft.approval,
    delegateToBotId: draft.delegateToBotId === null ? null : BotId.make(draft.delegateToBotId),
  });

  return (
    <>
      <BotThreadLanding
        key={panelKeys.thread}
        botId={botId}
        onOpenRoutines={() => setRoutinePanelRequest((request) => request + 1)}
      />
      {bot ? (
        <BotDetailsPanel
          key={panelKeys.details}
          bot={bot}
          threadRef={threadRef}
          routinePanelRequest={routinePanelRequest}
          routinePanel={{
            status: routinesView.kind,
            routines,
            skillOptions,
            connectorOptions: (snapshot?.mcpServers ?? []).map((server) => server.name),
            projectOptions: (snapshot?.projects ?? []).map((project) => ({
              id: project.id,
              name: project.title,
            })),
            delegateOptions,
            busyRoutineId,
            // A new routine reports back into the bot's own chat, so it can only be
            // created once that thread exists.
            createNeedsChat: threadRef === null,
            ...(threadRef
              ? {
                  onCreate: async (draft: RoutineAdapterDraft) => {
                    if (!environmentId) throw new Error("The routine environment is unavailable.");
                    const routineId = RoutineId.make(randomUUID());
                    await withBusy(routineId, async () => {
                      const result = await draftRoutine({
                        environmentId,
                        input: {
                          routineId,
                          targetThreadId: threadRef.threadId,
                          ...(await routineDefinition(draft)),
                          createdAt: new Date().toISOString(),
                        },
                      });
                      requireSuccess(result, t("Could not create routine"));
                      toastManager.add({ type: "success", title: t("Routine draft created") });
                    });
                  },
                }
              : {}),
            onUpdate: async (routineId, draft) => {
              if (!environmentId) throw new Error("The routine environment is unavailable.");
              const current = snapshot?.routines?.find((routine) => routine.id === routineId);
              if (!current) throw new Error("The routine no longer exists.");
              await withBusy(routineId, async () => {
                const result = await draftRoutine({
                  environmentId,
                  input: {
                    routineId: RoutineId.make(routineId),
                    targetThreadId: current.targetThreadId,
                    ...(await routineDefinition(draft)),
                    expectedProcedureVersion: current.procedureVersion,
                    createdAt: new Date().toISOString(),
                  },
                });
                requireSuccess(result, t("Could not save routine"));
                toastManager.add({ type: "success", title: t("Routine draft saved") });
              });
            },
            onApproveProcedure: (routineId) => {
              const current = snapshot?.routines?.find((routine) => routine.id === routineId);
              if (!environmentId || !current) return;
              startBusy(routineId, async () => {
                const result = await approveRoutine({
                  environmentId,
                  input: {
                    routineId: current.id,
                    procedureVersion: current.procedureVersion,
                    createdAt: new Date().toISOString(),
                  },
                });
                requireSuccess(result, t("Could not approve procedure"));
              });
            },
            onDryRun: (routineId) => {
              if (!environmentId) return;
              startBusy(routineId, async () => {
                const result = await runRoutine({
                  environmentId,
                  input: {
                    routineId: RoutineId.make(routineId),
                    runId: RoutineRunId.make(randomUUID()),
                    trigger: "dry-run",
                    createdAt: new Date().toISOString(),
                  },
                });
                requireSuccess(result, t("Could not start dry run"));
              });
            },
            onRunNow: (routineId) => {
              if (!environmentId) return;
              startBusy(routineId, async () => {
                const result = await runRoutine({
                  environmentId,
                  input: {
                    routineId: RoutineId.make(routineId),
                    runId: RoutineRunId.make(randomUUID()),
                    trigger: "manual",
                    createdAt: new Date().toISOString(),
                  },
                });
                requireSuccess(result, t("Could not start routine"));
              });
            },
            onSetEnabled: (routineId, enabled) => {
              if (!environmentId) return;
              startBusy(routineId, async () => {
                const createdAt = new Date().toISOString();
                const result = enabled
                  ? await enableRoutine({
                      environmentId,
                      input: { routineId: RoutineId.make(routineId), createdAt },
                    })
                  : await pauseRoutine({
                      environmentId,
                      input: {
                        routineId: RoutineId.make(routineId),
                        reason: "Paused by the user.",
                        createdAt,
                      },
                    });
                requireSuccess(
                  result,
                  enabled ? t("Could not enable routine") : t("Could not pause routine"),
                );
              });
            },
            onSetPaused: (routineId, paused) => {
              if (!environmentId) return;
              startBusy(routineId, async () => {
                const createdAt = new Date().toISOString();
                const result = paused
                  ? await pauseRoutine({
                      environmentId,
                      input: {
                        routineId: RoutineId.make(routineId),
                        reason: "Paused by the user.",
                        createdAt,
                      },
                    })
                  : await enableRoutine({
                      environmentId,
                      input: { routineId: RoutineId.make(routineId), createdAt },
                    });
                requireSuccess(
                  result,
                  paused ? t("Could not pause routine") : t("Could not resume routine"),
                );
              });
            },
            onDelete: async (routineId) => {
              if (!environmentId) throw new Error("The routine environment is unavailable.");
              await withBusy(routineId, async () => {
                const result = await deleteRoutine({
                  environmentId,
                  input: {
                    routineId: RoutineId.make(routineId),
                    createdAt: new Date().toISOString(),
                  },
                });
                requireSuccess(result, t("Could not delete routine"));
              });
            },
          }}
          onOpenSettings={() => {
            void navigate({ to: "/bots/$botId/settings", params: { botId } });
          }}
        />
      ) : null}
    </>
  );
}

export const Route = createFileRoute("/_chat/bots/$botId")({
  component: BotThreadRouteView,
});
