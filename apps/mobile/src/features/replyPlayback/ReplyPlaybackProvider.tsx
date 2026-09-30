import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { type ReplyPlaybackSession } from "@akeru/client-runtime/reply-playback";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@akeru/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { createMobileReplyPlaybackSession } from "./mobileReplyPlaybackSession";

const ReplyPlaybackContext = createContext<ReplyPlaybackSession | null>(null);

// Mounted above the navigation container, so nothing here may read route
// state; the environment id travels on each playback request instead.
export function ReplyPlaybackProvider({ children }: { readonly children: ReactNode }) {
  const synthesize = useAtomCommand(serverEnvironment.synthesizeVoice, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelVoice, { reportFailure: false });
  const session = useMemo(
    () =>
      createMobileReplyPlaybackSession({
        synthesize,
        cancel,
        voiceSettings: (environmentId) =>
          (
            appAtomRegistry.get(
              serverEnvironment.settingsValueAtom(EnvironmentId.make(environmentId)),
            ) ?? DEFAULT_SERVER_SETTINGS
          ).voice,
      }),
    [cancel, synthesize],
  );
  useEffect(() => {
    void session.preference.load();
    return () => session.dispose();
  }, [session]);
  return <ReplyPlaybackContext.Provider value={session}>{children}</ReplyPlaybackContext.Provider>;
}

export function useOptionalReplyPlayback() {
  return useContext(ReplyPlaybackContext);
}
