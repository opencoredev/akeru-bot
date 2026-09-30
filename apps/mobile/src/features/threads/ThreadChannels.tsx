import { useAtomValue } from "@effect/atom-react";
import {
  channelBindingNeedsProject,
  channelBindingPresentation,
  channelFailureReason,
} from "@akeru/client-runtime/channel-presentation";
import {
  AuthAccessWriteScope,
  type BotId,
  type ChannelBinding,
  type EnvironmentId,
  type ProjectId,
} from "@akeru/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";

import { useMobileI18n } from "../../lib/i18n";
import { botEnvironment } from "../../state/bots";
import { environmentSession } from "../../state/session";
import { environmentSnapshotAtom } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

export function ThreadChannels(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId | null;
}) {
  const { t } = useMobileI18n();
  const snapshot = useAtomValue(environmentSnapshotAtom(props.environmentId));
  const sessionResult = useAtomValue(environmentSession.sessionStateAtom(props.environmentId));
  const session = Option.getOrNull(AsyncResult.value(sessionResult));
  const canManageChannels =
    session?.authenticated === true && session.scopes?.includes(AuthAccessWriteScope) === true;
  const changeProject = useAtomCommand(botEnvironment.channels.changeProject, {
    reportFailure: false,
  });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const bot = snapshot?.bots.find((candidate) => candidate.id === props.botId);
  if (!bot?.channelBindings.length) return null;
  const projects = snapshot?.projects ?? [];

  // Blocked bindings are repaired by restarting the channel in a live project the user picks.
  const repair = async (binding: ChannelBinding, key: string, projectId: ProjectId) => {
    if (busyKey) return;
    setBusyKey(key);
    const result = await changeProject({
      environmentId: props.environmentId,
      input: { botId: binding.botId, provider: binding.provider, projectId },
    });
    setBusyKey(null);
    if (result._tag === "Failure") Alert.alert(t("Could not move channel to this project"));
  };

  return (
    <View className="mb-3 gap-2" accessibilityLabel={t("Channels")}>
      <Text className="font-t3-medium text-sm text-neutral-900 dark:text-neutral-100">
        {t("Channels")}
      </Text>
      {bot.channelBindings.map((binding, index) => {
        const channel = channelBindingPresentation(binding, projects);
        const key = binding.connectionId ?? `${binding.provider}:${index}`;
        const needsProject = channelBindingNeedsProject(binding, projects);
        const warning = binding.failureCategory
          ? channelFailureReason(binding.failureCategory, binding.provider, t)
          : needsProject
            ? channel.warning
            : (binding.lastError ?? channel.warning);
        return (
          <View key={key} className="gap-1">
            <Text className="font-t3-medium text-xs text-neutral-900 dark:text-neutral-100">
              {channel.provider} · {channel.health}
            </Text>
            {needsProject ? (
              <Text className="text-xs text-amber-700 dark:text-amber-400">
                {t(
                  "The project for this channel is unavailable. Choose another project to reconnect it.",
                )}
              </Text>
            ) : warning ? (
              <Text className="text-xs text-amber-700 dark:text-amber-400">{warning}</Text>
            ) : null}
            <Text className="text-xs text-neutral-600 dark:text-neutral-300">
              Project · {channel.project}
            </Text>
            <Text className="text-xs text-neutral-600 dark:text-neutral-300">
              Recent delivery · {channel.delivery}
            </Text>
            {needsProject && !canManageChannels ? (
              <Text className="text-xs text-neutral-600 dark:text-neutral-300">
                {t("Repair this channel from Settings > Bot channels on the host.")}
              </Text>
            ) : null}
            {needsProject && canManageChannels && projects.length === 0 ? (
              <Text className="text-xs text-neutral-600 dark:text-neutral-300">
                {t("Add a project before connecting a channel.")}
              </Text>
            ) : null}
            {needsProject && canManageChannels
              ? projects.map((project) => (
                  <Pressable
                    key={project.id}
                    accessibilityRole="button"
                    className="self-start rounded-xl border border-border px-3 py-1.5 active:bg-subtle disabled:opacity-40"
                    disabled={busyKey !== null}
                    onPress={() => void repair(binding, key, project.id)}
                  >
                    <Text className="font-t3-medium text-xs text-neutral-900 dark:text-neutral-100">
                      {t("Reconnect in {project}", { project: project.title })}
                    </Text>
                  </Pressable>
                ))
              : null}
          </View>
        );
      })}
    </View>
  );
}
