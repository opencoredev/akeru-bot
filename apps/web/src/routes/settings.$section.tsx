import { createFileRoute, redirect } from "@tanstack/react-router";

import { SettingsPanelForSection } from "../components/settings/SettingsDialog";
import {
  LEGACY_SETTINGS_SECTIONS,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "../settingsDialogStore";

function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export const Route = createFileRoute("/settings/$section")({
  beforeLoad: ({ params }) => {
    if (isSettingsSection(params.section)) return;
    // Plugins moved out of Settings into their own page.
    if (params.section === "plugins") {
      throw redirect({ to: "/plugins", replace: true });
    }
    const legacy = LEGACY_SETTINGS_SECTIONS[params.section];
    throw redirect({
      to: "/settings/$section",
      params: { section: legacy?.section ?? "general" },
      ...(legacy?.targetId ? { hash: legacy.targetId } : {}),
      replace: true,
    });
  },
  component: SettingsSectionPage,
});

function SettingsSectionPage() {
  const { section } = Route.useParams();
  if (!isSettingsSection(section)) return null;
  return <SettingsPanelForSection section={section} />;
}
