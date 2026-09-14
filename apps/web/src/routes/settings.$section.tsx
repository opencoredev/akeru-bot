import { createFileRoute, redirect } from "@tanstack/react-router";

import { SettingsPanelForSection } from "../components/settings/SettingsDialog";
import { SETTINGS_SECTIONS, type SettingsSection } from "../settingsDialogStore";

function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export const Route = createFileRoute("/settings/$section")({
  beforeLoad: ({ params }) => {
    if (!isSettingsSection(params.section)) {
      throw redirect({
        to: "/settings/$section",
        params: { section: "general" },
        replace: true,
      });
    }
  },
  component: SettingsSectionPage,
});

function SettingsSectionPage() {
  const { section } = Route.useParams();
  if (!isSettingsSection(section)) return null;
  return <SettingsPanelForSection section={section} />;
}
