import {
  boundedRunHistory,
  botRoutinesView,
  routineDateLabel,
  routineLifecycleAction,
  routineScheduleLabel,
  routineStateNote,
  routineStatus,
  runStatusTone,
  runSummaryLine,
  type RoutineAdapterItem,
} from "@t3tools/client-runtime/routines";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { RoutineId, RoutineRunId, type EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { randomUUID } from "expo-crypto";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";
import { routineEnvironment } from "../../state/routines";
import { useEnvironmentOperateAccess } from "../../state/session";
import { environmentSnapshotAtom } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

type RoutinesRouteParams = {
  readonly ThreadSettingsRoutines: {
    readonly environmentId: EnvironmentId;
    readonly botId: string;
    readonly botName?: string;
  };
};

const TONE_TEXT_CLASS = {
  success: "text-success",
  error: "text-danger",
  warning: "text-warning",
  info: "text-foreground",
  secondary: "text-foreground-muted",
} as const;

function ActionButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "plain" | "destructive";
}) {
  const tone = props.tone ?? "plain";
  return (
    <Pressable
      accessibilityRole="button"
      className={
        tone === "primary"
          ? "rounded-xl bg-accent px-3 py-2 active:opacity-70 disabled:opacity-40"
          : "rounded-xl bg-subtle px-3 py-2 active:opacity-70 disabled:opacity-40"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text
        className={
          tone === "primary"
            ? "text-sm font-t3-bold text-accent-foreground"
            : tone === "destructive"
              ? "text-sm font-t3-medium text-danger"
              : "text-sm font-t3-medium text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function RoutineCard(props: {
  readonly routine: RoutineAdapterItem;
  /** The bot that does each run's work, when it is not the owner. */
  readonly doneBy: string | null;
  readonly busy: boolean;
  readonly canOperate: boolean;
  readonly error: string | null;
  readonly onApprove: () => void;
  readonly onLifecycle: (action: "resume" | "enable" | "pause") => void;
  readonly onRun: (trigger: "manual" | "dry-run") => void;
  readonly onDelete: () => void;
}) {
  const i18n = useMobileI18n();
  const { t } = i18n;
  const { routine } = props;
  const status = routineStatus(routine);
  const lifecycle = routineLifecycleAction(routine);
  const history = boundedRunHistory(routine.runHistory);
  const disabled = props.busy || !props.canOperate;
  const stateNote = routineStateNote(routine);

  return (
    <View className="gap-3 rounded-2xl bg-card p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text className="font-t3-bold text-foreground">{routine.name}</Text>
          <Text className="text-xs text-foreground-muted">
            {routineScheduleLabel(routine.schedule, i18n)}
          </Text>
        </View>
        <Text className={`text-xs font-t3-medium ${TONE_TEXT_CLASS[status.variant]}`}>
          {t(status.label)}
        </Text>
      </View>
      {stateNote ? <Text className="text-sm text-foreground-muted">{t(stateNote)}</Text> : null}
      {!routine.procedureApproved && routine.prompt.trim() ? (
        <View className="gap-1">
          <Text className="text-xs font-t3-medium text-foreground-muted">{t("What it does")}</Text>
          <Text className="text-sm text-foreground">{routine.prompt}</Text>
        </View>
      ) : null}
      <View className="gap-1">
        <Text className="text-xs text-foreground-muted">
          {t("Next run")}: {routineDateLabel(routine.nextRunAt, i18n)}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {t("Last run")}: {routineDateLabel(routine.lastRunAt, i18n)}
        </Text>
        {props.doneBy !== null ? (
          <Text className="text-xs text-foreground-muted">
            {t("Done by")}: {props.doneBy}
          </Text>
        ) : null}
      </View>
      {history.length > 0 ? (
        <View className="gap-2">
          <Text className="text-xs font-t3-medium text-foreground-muted">{t("Latest run")}</Text>
          {history.map((run) => {
            const tone = runStatusTone(run.status);
            return (
              <View key={run.id} className="flex-row items-start gap-2">
                <Text className={`text-xs font-t3-medium ${TONE_TEXT_CLASS[tone.variant]}`}>
                  {t(tone.label)}
                </Text>
                <Text className="flex-1 text-xs text-foreground" numberOfLines={2}>
                  {runSummaryLine(run, i18n)}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {routineDateLabel(run.startedAt, i18n)}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {props.error ? <Text className="text-sm text-danger">{props.error}</Text> : null}
      <View className="flex-row flex-wrap items-center gap-2">
        {!routine.procedureApproved ? (
          <ActionButton
            disabled={disabled}
            label={t("Approve procedure")}
            onPress={props.onApprove}
            tone="primary"
          />
        ) : null}
        {lifecycle ? (
          <ActionButton
            disabled={disabled}
            label={
              lifecycle === "resume"
                ? t("Resume")
                : lifecycle === "pause"
                  ? t("Pause")
                  : t("Enable")
            }
            onPress={() => props.onLifecycle(lifecycle)}
          />
        ) : null}
        <ActionButton
          disabled={disabled}
          label={t("Test")}
          onPress={() => props.onRun("dry-run")}
        />
        <ActionButton
          disabled={disabled || !routine.procedureApproved}
          label={t("Run now")}
          onPress={() => props.onRun("manual")}
        />
        <ActionButton
          disabled={disabled}
          label={t("Delete")}
          onPress={props.onDelete}
          tone="destructive"
        />
        {props.busy ? <ActivityIndicator /> : null}
      </View>
    </View>
  );
}

/** One bot's routines, opened from the chat settings sheet. */
export function ThreadRoutinesScreen() {
  const route = useRoute<RouteProp<RoutinesRouteParams, "ThreadSettingsRoutines">>();
  const insets = useSafeAreaInsets();
  const { t } = useMobileI18n();
  const { environmentId, botId } = route.params;
  const botName = route.params.botName ?? t("this bot");
  const snapshot = useAtomValue(environmentSnapshotAtom(environmentId));
  const view = useMemo(() => botRoutinesView(snapshot, botId), [snapshot, botId]);
  const canOperate = useEnvironmentOperateAccess(environmentId) === "granted";
  const approve = useAtomCommand(routineEnvironment.approve, { reportFailure: false });
  const enable = useAtomCommand(routineEnvironment.enable, { reportFailure: false });
  const pause = useAtomCommand(routineEnvironment.pause, { reportFailure: false });
  const run = useAtomCommand(routineEnvironment.run, { reportFailure: false });
  const remove = useAtomCommand(routineEnvironment.delete, { reportFailure: false });
  const [busyRoutineId, setBusyRoutineId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ routineId: string; message: string } | null>(null);

  const perform = async (
    routineId: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
    fallback: string,
  ) => {
    if (busyRoutineId) return;
    setBusyRoutineId(routineId);
    setFailure(null);
    try {
      const result = await action();
      if (result._tag === "Failure") {
        // Server errors can be technical English, so the card shows only translated copy.
        setFailure({ routineId, message: fallback });
      }
    } finally {
      setBusyRoutineId(null);
    }
  };

  if (view.kind === "loading") {
    return (
      <View className="flex-1 items-center justify-center bg-sheet">
        <ActivityIndicator accessibilityLabel={t("Loading routines")} />
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerStyle={{ gap: 12, padding: 16, paddingBottom: insets.bottom + 20 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      {view.kind === "unavailable" ? (
        <View className="gap-1 rounded-2xl bg-card p-4">
          <Text className="text-sm text-foreground-muted">
            {t("Routines are not available for this environment.")}
          </Text>
        </View>
      ) : view.routines.length === 0 ? (
        <View className="gap-1 rounded-2xl bg-card p-4">
          <Text className="font-t3-bold text-foreground">{t("No routines")}</Text>
          <Text className="text-sm text-foreground-muted">
            {t("Routines are recurring tasks {botName} runs on a schedule.", { botName })}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {t("Or ask {botName} in chat to set one up.", { botName })}
          </Text>
        </View>
      ) : (
        view.routines.map((routine) => {
          const routineId = RoutineId.make(routine.id);
          return (
            <RoutineCard
              key={routine.id}
              doneBy={
                routine.delegateToBotId === null
                  ? null
                  : (snapshot?.bots.find((bot) => bot.id === routine.delegateToBotId)?.name ??
                    t("Unknown bot"))
              }
              busy={busyRoutineId === routine.id}
              canOperate={canOperate}
              error={failure?.routineId === routine.id ? failure.message : null}
              routine={routine}
              onApprove={() => {
                const current = snapshot?.routines?.find((item) => item.id === routine.id);
                if (!current) return;
                void perform(
                  routine.id,
                  () =>
                    approve({
                      environmentId,
                      input: {
                        routineId,
                        procedureVersion: current.procedureVersion,
                        createdAt: new Date().toISOString(),
                      },
                    }),
                  t("Could not approve procedure"),
                );
              }}
              onLifecycle={(action) => {
                const createdAt = new Date().toISOString();
                void perform(
                  routine.id,
                  () =>
                    action === "pause"
                      ? pause({
                          environmentId,
                          input: { routineId, reason: "Paused by the user.", createdAt },
                        })
                      : enable({ environmentId, input: { routineId, createdAt } }),
                  action === "pause"
                    ? t("Could not pause routine")
                    : action === "resume"
                      ? t("Could not resume routine")
                      : t("Could not enable routine"),
                );
              }}
              onRun={(trigger) =>
                void perform(
                  routine.id,
                  () =>
                    run({
                      environmentId,
                      input: {
                        routineId,
                        runId: RoutineRunId.make(randomUUID()),
                        trigger,
                        createdAt: new Date().toISOString(),
                      },
                    }),
                  trigger === "dry-run"
                    ? t("Could not start dry run")
                    : t("Could not start routine"),
                )
              }
              onDelete={() =>
                Alert.alert(
                  t("Delete routine “{name}”?", { name: routine.name }),
                  t("This removes the schedule and its run history."),
                  [
                    { text: t("Cancel"), style: "cancel" },
                    {
                      text: t("Delete"),
                      style: "destructive",
                      onPress: () =>
                        void perform(
                          routine.id,
                          () =>
                            remove({
                              environmentId,
                              input: { routineId, createdAt: new Date().toISOString() },
                            }),
                          t("Could not delete routine"),
                        ),
                    },
                  ],
                )
              }
            />
          );
        })
      )}
    </ScrollView>
  );
}
