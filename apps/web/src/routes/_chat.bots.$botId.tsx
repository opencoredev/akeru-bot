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
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { BotThreadLanding } from "../components/roster/BotThreadLanding";
import { BotDetailsPanel } from "../components/roster/BotDetailsPanel";
import { useBotThreadRef } from "../components/roster/useBotThreadRef";
import type { RoutineAdapterDraft } from "../components/roster/RoutinePanel";
import { toRoutinePanelItem, toRoutineSchedule } from "../components/roster/routineAdapter";
import { useRosterStore } from "../components/roster/rosterStore";
import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { botRoutePanelKeys } from "./botRoutePanelKeys";
import { botEnvironment } from "../state/bots";
import { usePrimaryEnvironmentId } from "../state/environments";
import { routineEnvironment } from "../state/routines";
import { primaryServerProvidersAtom } from "../state/server";
import { environmentSnapshotAtom } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";

const NO_ENVIRONMENT = "" as EnvironmentId;

function BotThreadRouteView() {
  const { botId } = Route.useParams();
  const panelKeys = botRoutePanelKeys(botId);
  const environmentId = usePrimaryEnvironmentId();
  const updateBot = useAtomCommand(botEnvironment.update, { reportFailure: false });
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
  const bot = useRosterStore((state) =>
    state.bots.find((candidate) => candidate.id === botId && candidate.archivedAt === null),
  );
  const threadRef = useBotThreadRef(botId);
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
  const routines = useMemo(
    () =>
      (snapshot?.routines ?? [])
        .filter((routine) => routine.botId === botId && routine.lifecycle !== "deleted")
        .map((routine) =>
          toRoutinePanelItem(
            routine,
            snapshot?.routineRuns ?? [],
            snapshot?.skillAssignments ?? [],
            snapshot?.mcpServers ?? [],
          ),
        ),
    [botId, snapshot],
  );

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
      requireSuccess(result, `Could not assign ${name}`);
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
  });

  return (
    <>
      <BotThreadLanding key={panelKeys.thread} botId={botId} />
      {bot ? (
        <BotDetailsPanel
          key={panelKeys.details}
          bot={bot}
          threadRef={threadRef}
          routinePanel={{
            status:
              snapshot === null
                ? "loading"
                : snapshot.routines === undefined
                  ? "unavailable"
                  : "ready",
            routines,
            skillOptions,
            connectorOptions: (snapshot?.mcpServers ?? []).map((server) => server.name),
            projectOptions: (snapshot?.projects ?? []).map((project) => ({
              id: project.id,
              name: project.title,
            })),
            busyRoutineId,
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
                requireSuccess(result, "Could not save routine");
                toastManager.add({ type: "success", title: "Routine draft saved" });
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
                requireSuccess(result, "Could not approve procedure");
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
                requireSuccess(result, "Could not start dry run");
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
                requireSuccess(result, "Could not start routine");
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
                  enabled ? "Could not enable routine" : "Could not pause routine",
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
                  paused ? "Could not pause routine" : "Could not resume routine",
                );
              });
            },
            onDelete: (routineId) => {
              if (!environmentId) return;
              startBusy(routineId, async () => {
                const result = await deleteRoutine({
                  environmentId,
                  input: {
                    routineId: RoutineId.make(routineId),
                    createdAt: new Date().toISOString(),
                  },
                });
                requireSuccess(result, "Could not delete routine");
              });
            },
          }}
          onSaveBot={async ({
            name,
            label,
            description,
            engine,
            usageCap,
            sandbox,
            voiceEnabled,
            disabledMcpServerIds,
          }) => {
            if (!environmentId) return false;
            const result = await updateBot({
              environmentId,
              input: {
                botId: BotId.make(bot.id),
                name,
                label,
                description,
                engine,
                usageCap,
                sandbox,
                voiceEnabled,
                disabledMcpServerIds,
              },
            });
            if (result._tag === "Failure") {
              toastManager.add({ type: "error", title: "Could not save bot settings" });
              return false;
            }
            toastManager.add({ type: "success", title: "Bot settings saved" });
            return true;
          }}
        />
      ) : null}
    </>
  );
}

export const Route = createFileRoute("/_chat/bots/$botId")({
  component: BotThreadRouteView,
});
