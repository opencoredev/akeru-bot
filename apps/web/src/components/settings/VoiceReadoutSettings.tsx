import { useSyncExternalStore } from "react";
import { Switch } from "../ui/switch";
import type { ReplyReadoutPreference } from "@akeru/client-runtime/reply-playback";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useI18n } from "../../i18n";

export function AutomaticReadoutRow({
  preference,
}: {
  readonly preference: ReplyReadoutPreference;
}) {
  const { t } = useI18n();

  const state = useSyncExternalStore(
    preference.subscribe,
    preference.getSnapshot,
    preference.getSnapshot,
  );

  return (
    <SettingsRow
      {...searchableSetting("voice-read-aloud", t)}
      description={
        state.persistenceError
          ? "This preference could not be saved on this device."
          : "Read new completed replies in the open chat on this device. History is never replayed. This does not start a live call or generate a new answer."
      }
      control={
        <Switch
          checked={state.enabled}
          onCheckedChange={(checked) => {
            void preference.setEnabled(Boolean(checked));
          }}
          aria-label="Read new replies aloud"
        />
      }
    />
  );
}
