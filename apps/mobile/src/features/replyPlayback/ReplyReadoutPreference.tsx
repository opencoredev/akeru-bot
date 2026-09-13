import { useSyncExternalStore } from "react";
import { View } from "react-native";
import type { ReplyReadoutPreference as Preference } from "@t3tools/client-runtime/reply-playback";

import { AppText } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";

export function ReplyReadoutPreference({ preference }: { readonly preference: Preference }) {
  const state = useSyncExternalStore(
    preference.subscribe,
    preference.getSnapshot,
    preference.getSnapshot,
  );
  const label = "Automatically read new replies in this chat on this device";
  return (
    <View className="gap-2">
      <View className="min-h-11 flex-row items-center gap-3">
        <AppText className="flex-1 text-base">{label}</AppText>
        <ThemedSwitch
          accessibilityRole="switch"
          accessibilityLabel={label}
          accessibilityState={{ checked: state.enabled }}
          value={state.enabled}
          onValueChange={(enabled) => {
            void preference.setEnabled(enabled);
          }}
        />
      </View>
      <AppText className="text-sm text-muted-foreground">
        Only new completed replies are read. History is never replayed. Your selected speech service
        may charge for audio.
      </AppText>
      {state.persistenceError ? (
        <AppText
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="text-sm text-muted-foreground"
        >
          This preference could not be saved on this device.
        </AppText>
      ) : null}
    </View>
  );
}
