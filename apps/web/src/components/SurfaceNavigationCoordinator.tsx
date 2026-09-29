import { useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { acknowledgePluginsNavigation, usePluginsDialogStore } from "../pluginsDialogStore";
import {
  acknowledgeSettingsNavigation,
  clearSettingsEnvironment,
  useSettingsDialogStore,
} from "../settingsDialogStore";
import { closeUsage, useUsageDialogStore } from "../usageDialogStore";
import { channelProviderFromSettingsTarget } from "./settings/channelProviderMeta";

/** Bridges legacy imperative open helpers to the routed workspace surfaces. */
export function SurfaceNavigationCoordinator() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const settingsSection = useSettingsDialogStore((state) => state.section);
  const settingsTarget = useSettingsDialogStore((state) => state.targetId);
  const pluginsOpen = usePluginsDialogStore((state) => state.open);
  const usageOpen = useUsageDialogStore((state) => state.open);

  useEffect(() => {
    if (settingsSection !== null) {
      // A channel target, such as a repair link, opens that provider's own page.
      const channel =
        settingsSection === "channels" ? channelProviderFromSettingsTarget(settingsTarget) : null;
      void (channel
        ? navigate({ to: "/settings/channels/$channel", params: { channel } })
        : navigate({
            to: "/settings/$section",
            params: { section: settingsSection },
            hash: settingsTarget ?? "",
          }));
      acknowledgeSettingsNavigation();
      return;
    }
    if (!pathname.startsWith("/settings")) clearSettingsEnvironment();
  }, [navigate, pathname, settingsSection, settingsTarget]);

  useEffect(() => {
    if (!pluginsOpen) return;
    void navigate({ to: "/plugins" });
    acknowledgePluginsNavigation();
  }, [navigate, pluginsOpen]);

  useEffect(() => {
    if (!usageOpen) return;
    void navigate({ to: "/usage" });
    closeUsage();
  }, [navigate, usageOpen]);

  return null;
}
