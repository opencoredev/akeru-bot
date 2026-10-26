import * as Predicate from "effect/Predicate";
import { CLOUD_COPY } from "@akeru/client-runtime/cloud-presentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@akeru/client-runtime/state/runtime";
import type { EnvironmentId } from "@akeru/contracts";

import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/** Link actions shared by Settings and the command palette. Failures surface as toasts. */
export function useCloudLinkCommands(environmentId: EnvironmentId | null) {
  const startLink = useAtomCommand(serverEnvironment.startCloudLink, { reportFailure: false });
  const cancelLink = useAtomCommand(serverEnvironment.cancelCloudLink, { reportFailure: false });
  const forget = useAtomCommand(serverEnvironment.forgetCloud, { reportFailure: false });
  const unlink = useAtomCommand(serverEnvironment.unlinkCloud, { reportFailure: false });

  const report = (title: string, result: Awaited<ReturnType<typeof startLink>>) => {
    if (!Predicate.isTagged(result, "Failure") || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The command failed.",
    });
  };

  return {
    forget: async () => {
      if (environmentId === null) return false;

      const confirmed = await ensureLocalApi().dialogs.confirm(
        `${CLOUD_COPY.forgetConfirmTitle}\n\n${CLOUD_COPY.forgetConfirmBody}`,
        { variant: "destructive" },
      );

      if (!confirmed) return false;
      report("Could not forget Akeru Cloud", await forget({ environmentId, input: {} }));

      return true;
    },
    connect: async () => {
      if (environmentId === null) return;
      report("Could not connect Akeru Cloud", await startLink({ environmentId, input: {} }));
    },
    cancel: async () => {
      if (environmentId === null) return;
      report("Could not cancel", await cancelLink({ environmentId, input: {} }));
    },
    /** Asks first, then revokes the cloud link. Returns false when the user backs out. */
    disconnect: async () => {
      if (environmentId === null) return false;

      const confirmed = await ensureLocalApi().dialogs.confirm(
        `${CLOUD_COPY.disconnectConfirmTitle}\n\n${CLOUD_COPY.disconnectConfirmBody}`,
        { variant: "destructive" },
      );

      if (!confirmed) return false;
      report("Could not disconnect Akeru Cloud", await unlink({ environmentId, input: {} }));

      return true;
    },
  };
}
