import { useSyncExternalStore } from "react";
import type { ReplyReadoutPreference as Preference } from "@t3tools/client-runtime/reply-playback";

export function ReplyReadoutPreference({ preference }: { readonly preference: Preference }) {
  const state = useSyncExternalStore(
    preference.subscribe,
    preference.getSnapshot,
    preference.getSnapshot,
  );
  return (
    <div className="space-y-1 text-sm">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={(event) => {
            void preference.setEnabled(event.target.checked);
          }}
        />
        <span>Automatically read new replies in this chat on this device</span>
      </label>
      <p className="text-xs text-muted-foreground">
        Only new completed replies are read. History is never replayed. Your selected speech service
        may charge for audio.
      </p>
      {state.persistenceError ? (
        <p role="status" className="text-xs text-muted-foreground">
          This preference could not be saved on this device.
        </p>
      ) : null}
    </div>
  );
}
