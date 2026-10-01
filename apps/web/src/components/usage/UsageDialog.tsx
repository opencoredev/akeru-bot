import { useEffect } from "react";

import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { useClientSettings } from "~/hooks/useSettings";
import { useUsage } from "~/state/usage";
import { closeUsage, useUsageDialogStore } from "~/usageDialogStore";

import { UsagePage } from "./UsagePage";

export function UsageDialog() {
  const open = useUsageDialogStore((state) => state.open);
  const { refresh } = useUsage();
  const refreshMinutes = useClientSettings((settings) => settings.usageRefreshMinutes);

  useEffect(() => {
    if (!open) return;
    const intervalMs = Math.max(1, refreshMinutes) * 60 * 1000;

    const timer = globalThis.setInterval(() => {
      refresh();
    }, intervalMs);

    return () => globalThis.clearInterval(timer);
  }, [open, refresh, refreshMinutes]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeUsage();
      }}
    >
      <DialogPopup
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="h-min-48rem-90dvh max-w-5xl flex-col overflow-hidden"
      >
        {open ? <UsagePage /> : null}
      </DialogPopup>
    </Dialog>
  );
}
