import { BrowserSettingsSection } from "./BrowserSettings";
import { ProvidersListSection } from "./ProviderDetailPage";
import { SandboxSettingsPanel } from "./SandboxSettingsPanel";
import { AdvancedSettingsSections, BotWorkspaceSettingsSection } from "./SettingsPanels";
import { SettingsPageContainer } from "./settingsLayout";
import { VoiceSettingsSection } from "./VoiceSettings";

// Pages that combine sections from several panels. Each section keeps its own
// anchor id so search results and deep links still land on the right row.

export function ProvidersSettingsPage() {
  return (
    <SettingsPageContainer>
      <ProvidersListSection />
      <VoiceSettingsSection />
    </SettingsPageContainer>
  );
}

export function SandboxSettingsPage() {
  return (
    <SettingsPageContainer>
      <BotWorkspaceSettingsSection />
      <SandboxSettingsPanel />
    </SettingsPageContainer>
  );
}

export function BrowserSettingsPage() {
  return (
    <SettingsPageContainer>
      <BrowserSettingsSection />
    </SettingsPageContainer>
  );
}

export function AdvancedSettingsPage() {
  return (
    <SettingsPageContainer>
      <AdvancedSettingsSections />
    </SettingsPageContainer>
  );
}
