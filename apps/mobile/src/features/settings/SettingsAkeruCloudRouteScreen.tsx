import * as Predicate from "effect/Predicate";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@akeru/client-runtime/state/runtime";
import * as Match from "effect/Match";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  CLOUD_COPY,
  CLOUD_HOSTED_SERVICES,
  cloudViewModel,
  type CloudConnectionTone,
} from "@akeru/client-runtime/cloud-presentation";
import type { EnvironmentId } from "@akeru/contracts";
import { useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export type SettingsAkeruCloudParams = {
  readonly environmentId?: EnvironmentId;
};

const TONE_DOT: Readonly<Record<CloudConnectionTone, string>> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500",
  offline: "bg-foreground-muted",
};

function ActionButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "destructive";
}) {
  const tone = props.tone ?? "primary";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        tone === "primary"
          ? "rounded-[14px] bg-foreground px-4 py-3"
          : "rounded-[14px] bg-subtle px-4 py-3"
      }
      style={props.disabled ? { opacity: 0.45 } : undefined}
    >
      <Text
        className={Match.value(tone).pipe(
          Match.when("primary", () => "text-center text-sm font-t3-medium text-background"),
          Match.when(
            "destructive",
            () => "text-center text-sm font-t3-medium text-danger-foreground",
          ),
          Match.orElse(() => "text-center text-sm font-t3-medium text-foreground"),
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function SettingsAkeruCloudRouteScreen({
  route,
}: StaticScreenProps<SettingsAkeruCloudParams | undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = route.params?.environmentId;

  const status = useEnvironmentQuery(
    environmentId ? serverEnvironment.cloudStatus({ environmentId, input: {} }) : null,
  );

  const view = cloudViewModel(status.data);
  const startLink = useAtomCommand(serverEnvironment.startCloudLink);
  const cancelLink = useAtomCommand(serverEnvironment.cancelCloudLink);
  const forget = useAtomCommand(serverEnvironment.forgetCloud);
  const unlink = useAtomCommand(serverEnvironment.unlinkCloud);
  const [pending, setPending] = useState(false);

  const run = (action: () => ReturnType<typeof startLink>) => () => {
    setPending(true);
    void action()
      .then((result) => {
        if (Predicate.isTagged(result, "Failure") && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            CLOUD_COPY.title,
            error instanceof Error ? error.message : "The command failed.",
          );
        }
      })
      .finally(() => setPending(false));
  };

  if (!environmentId) {
    return (
      <View className="flex-1 bg-sheet p-5">
        <Text className="text-sm text-foreground-muted">
          Open Akeru Cloud from Settings for the environment you want to connect.
        </Text>
      </View>
    );
  }

  const confirmForget = () =>
    Alert.alert(CLOUD_COPY.forgetConfirmTitle, CLOUD_COPY.forgetConfirmBody, [
      { text: CLOUD_COPY.cancel, style: "cancel" },
      {
        text: CLOUD_COPY.forget,
        style: "destructive",
        onPress: run(() => forget({ environmentId, input: {} })),
      },
    ]);

  const confirmDisconnect = () =>
    Alert.alert(CLOUD_COPY.disconnectConfirmTitle, CLOUD_COPY.disconnectConfirmBody, [
      { text: CLOUD_COPY.cancel, style: "cancel" },
      {
        text: CLOUD_COPY.disconnect,
        style: "destructive",
        onPress: run(() => unlink({ environmentId, input: {} })),
      },
    ]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={CLOUD_COPY.title} onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {view.kind === "loading" ? (
          <Text className="py-16 text-center text-sm text-foreground-muted">
            {status.error ?? "Loading…"}
          </Text>
        ) : null}

        {view.kind === "unlinked" || view.kind === "revoked" ? (
          <SettingsSection title={CLOUD_COPY.title} card>
            <View className="gap-4 p-4">
              {view.kind === "revoked" ? (
                <Text className="text-base font-t3-medium text-foreground">
                  {CLOUD_COPY.revoked}
                </Text>
              ) : null}
              <Text className="text-sm text-foreground-muted">{CLOUD_COPY.explainer}</Text>
              <ActionButton
                label={view.kind === "revoked" ? CLOUD_COPY.connectAgain : CLOUD_COPY.connect}
                disabled={pending}
                onPress={run(() => startLink({ environmentId, input: {} }))}
              />
            </View>
          </SettingsSection>
        ) : null}

        {view.kind === "linking" ? (
          <SettingsSection title={CLOUD_COPY.title} card>
            <View className="gap-4 p-4">
              <Text className="text-sm text-foreground-muted">{CLOUD_COPY.enterCode}</Text>
              <Text
                selectable
                className="text-center font-mono text-3xl font-t3-bold tracking-[3px] text-foreground"
              >
                {view.userCode}
              </Text>
              <Text className="text-center text-sm text-foreground-muted">
                {CLOUD_COPY.waiting}
              </Text>
              <ActionButton
                label={CLOUD_COPY.openVerification}
                onPress={() =>
                  void Linking.openURL(view.verificationUrl).catch((error) =>
                    Alert.alert(
                      CLOUD_COPY.title,
                      error instanceof Error
                        ? error.message
                        : "The verification page could not be opened.",
                    ),
                  )
                }
              />
              <ActionButton
                label={CLOUD_COPY.cancel}
                tone="secondary"
                disabled={pending}
                onPress={run(() => cancelLink({ environmentId, input: {} }))}
              />
            </View>
          </SettingsSection>
        ) : null}

        {view.kind === "linked" ? (
          <>
            <SettingsSection title={CLOUD_COPY.title} card>
              <View className="gap-1 border-b border-border-subtle p-4">
                <Text className="text-xs font-t3-medium text-foreground-muted">
                  {CLOUD_COPY.account}
                </Text>
                <Text className="text-base text-foreground">{view.email}</Text>
              </View>
              <View className="flex-row items-center justify-between p-4">
                <Text className="text-base text-foreground">{CLOUD_COPY.connection}</Text>
                <View className="flex-row items-center gap-2">
                  <View className={`size-2 rounded-full ${TONE_DOT[view.connectionTone]}`} />
                  <Text className="text-base text-foreground-muted">{view.connectionLabel}</Text>
                </View>
              </View>
            </SettingsSection>
            <SettingsSection title={CLOUD_COPY.hostedServices} card>
              {CLOUD_HOSTED_SERVICES.map((service) => (
                <View key={service.id} className="gap-1 p-4">
                  <Text className="text-base text-foreground">{service.label}</Text>
                  <Text className="text-sm text-foreground-muted">{service.detail}</Text>
                </View>
              ))}
            </SettingsSection>
            <Text className="text-sm text-foreground-muted">{CLOUD_COPY.forgetConfirmBody}</Text>
            <ActionButton
              label={CLOUD_COPY.forget}
              tone="destructive"
              disabled={pending}
              onPress={confirmForget}
            />
            <ActionButton
              label={CLOUD_COPY.disconnect}
              tone="destructive"
              disabled={pending}
              onPress={confirmDisconnect}
            />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
