import { explainComputerCapability } from "@t3tools/client-runtime/state/computer-viewer";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import {
  closeComputerViewer,
  useComputerViewerStore,
  type ComputerViewerTarget,
} from "../../computerViewerStore";
import { useI18n } from "../../i18n";
import { useBotEngineAvailability } from "../roster/useBotEngineAvailability";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { ComputerViewerPanel } from "./ComputerViewerPanel";
import { useComputerViewer } from "./useComputerViewer";

function ComputerViewerSurface({ target }: { readonly target: ComputerViewerTarget }) {
  const { t } = useI18n();
  const { controller, state, view } = useComputerViewer(target.threadRef, true);
  const engine = useBotEngineAvailability(target.engine);
  const driverKind =
    engine.instanceEntries.find((entry) => entry.instanceId === engine.selection?.instanceId)
      ?.driverKind ?? null;
  const capability = explainComputerCapability({
    sandbox: target.sandbox,
    provider: driverKind,
    state: state.server,
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("{name}'s computer", { name: target.botName })}</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <ComputerViewerPanel
          botName={target.botName}
          view={view}
          frame={state.frame}
          notice={state.notice}
          capability={capability}
          onTakeControl={() => void controller.takeControl()}
          onReturnControl={() => void controller.returnControl()}
          onStop={() => void controller.stop()}
          onResume={() => void controller.resume()}
          onInput={controller.sendInput}
        />
      </DialogPanel>
    </>
  );
}

/**
 * The single computer viewer. Leaving the page it was opened from closes it,
 * which stops streaming and hands any held control back to the bot.
 */
export function ComputerViewerDialog() {
  const target = useComputerViewerStore((state) => state.target);
  const pathname = useLocation({ select: (location) => location.pathname });
  const openedAtRef = useRef<string | null>(null);

  useEffect(() => {
    if (target === null) {
      openedAtRef.current = null;
      return;
    }
    if (openedAtRef.current === null) openedAtRef.current = pathname;
    else if (openedAtRef.current !== pathname) closeComputerViewer();
  }, [pathname, target]);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) closeComputerViewer();
      }}
    >
      <DialogPopup className="max-w-5xl" bottomStickOnMobile={false}>
        {target ? (
          <ComputerViewerSurface
            key={`${target.threadRef.environmentId}:${target.threadRef.threadId}`}
            target={target}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
