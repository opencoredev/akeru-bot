import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SandboxProvider, SandboxSettings } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  canSaveSandboxProviderConnection,
  type CloudSandboxProvider,
  disconnectSandboxProvider,
  isSandboxProviderConnected,
  SANDBOX_PROVIDER_DEFINITIONS,
  sandboxConnectionDraft,
  sandboxProviderDefinition,
  saveSandboxProviderConnection,
  selectableSandboxProviders,
} from "./SandboxSettingsPanel.logic";

const SANDBOX_PROVIDER_LABELS: Readonly<Record<SandboxProvider, string>> = {
  local: "Local",
  e2b: "E2B",
  daytona: "Daytona",
  vercel: "Vercel Sandbox",
  upstash: "Upstash Box",
};

function errorMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The server rejected these sandbox settings.";
}

export function SandboxSettingsPanel() {
  const environmentId = useSettingsEnvironmentId();
  if (environmentId === null) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Connect to an environment first.</div>
    );
  }
  return <EnvironmentSandboxSettingsPanel key={environmentId} environmentId={environmentId} />;
}

function EnvironmentSandboxSettingsPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const sandbox = useEnvironmentSettings(environmentId, (settings) => settings.sandbox);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [editingProvider, setEditingProvider] = useState<CloudSandboxProvider | null>(null);
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const persist = async (next: SandboxSettings) => {
    setSaving(true);
    setError(null);
    const result = await updateSettings({ environmentId, input: { patch: { sandbox: next } } });
    setSaving(false);
    if (result._tag === "Failure") {
      setError(errorMessage(result));
      return false;
    }
    return true;
  };

  const openConnection = (provider: CloudSandboxProvider) => {
    setEditingProvider(provider);
    setDraft(sandboxConnectionDraft(sandbox, provider));
    setError(null);
  };

  const closeConnection = () => {
    if (saving) return;
    setEditingProvider(null);
    setDraft({});
    setError(null);
  };

  const saveConnection = async () => {
    if (editingProvider === null) return;
    const next = saveSandboxProviderConnection({
      settings: sandbox,
      provider: editingProvider,
      draft,
    });
    if (await persist(next)) closeConnection();
  };

  const editingDefinition = editingProvider ? sandboxProviderDefinition(editingProvider) : null;
  const canSave =
    editingProvider !== null &&
    canSaveSandboxProviderConnection({ settings: sandbox, provider: editingProvider, draft });

  return (
    <>
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("sandbox")}>
          <SettingsRow
            {...searchableSetting("default-sandbox")}
            description="Bots without an override use this sandbox."
            control={
              <Select
                value={sandbox.defaultProvider}
                onValueChange={(value) => {
                  if (value === null) return;
                  const provider = value as SandboxProvider;
                  if (!selectableSandboxProviders(sandbox).includes(provider)) return;
                  void persist({ ...sandbox, defaultProvider: provider });
                }}
              >
                <SelectTrigger className="w-44" aria-label="Default sandbox">
                  <SelectValue>{SANDBOX_PROVIDER_LABELS[sandbox.defaultProvider]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {selectableSandboxProviders(sandbox).map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {SANDBOX_PROVIDER_LABELS[provider]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...searchableSetting("sandbox-auto-idle")}
            description="Akeru pauses remote sandboxes when bots are idle."
            control={<Switch checked disabled aria-label="Auto-idle" />}
          />
        </SettingsSection>

        <SettingsSection title="Providers">
          <SettingsRow
            title="Local"
            description="This computer. No credential required."
            control={<Badge variant="success">Connected</Badge>}
          />
          {SANDBOX_PROVIDER_DEFINITIONS.map((definition) => {
            const connected = isSandboxProviderConnected(sandbox, definition.id);
            return (
              <SettingsRow
                key={definition.id}
                title={definition.label}
                description={definition.description}
                control={
                  <div className="flex items-center gap-2">
                    <Badge variant={connected ? "success" : "secondary"}>
                      {connected ? "Connected" : "Not connected"}
                    </Badge>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => openConnection(definition.id)}
                    >
                      {connected ? "Reconnect" : "Connect"}
                    </Button>
                    {connected ? (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={saving}
                        onClick={() =>
                          void persist(disconnectSandboxProvider(sandbox, definition.id))
                        }
                      >
                        Disconnect
                      </Button>
                    ) : null}
                  </div>
                }
              />
            );
          })}
        </SettingsSection>
      </SettingsPageContainer>

      <Dialog open={editingProvider !== null} onOpenChange={(open) => !open && closeConnection()}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {editingDefinition ? `Connect ${editingDefinition.label}` : "Connect sandbox"}
            </DialogTitle>
            <DialogDescription>
              The server stores these credentials in its secret store.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            {editingDefinition?.fields.map((field) => (
              <label key={field.name} className="grid gap-1.5 text-sm font-medium">
                {field.label}
                <Input
                  type={field.secret ? "password" : undefined}
                  autoComplete="off"
                  value={draft[field.name] ?? ""}
                  placeholder={field.secret ? "Leave blank to keep the saved value" : undefined}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [field.name]: event.currentTarget.value }))
                  }
                />
              </label>
            ))}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={closeConnection}>
              Cancel
            </Button>
            <Button disabled={!canSave || saving} onClick={() => void saveConnection()}>
              {saving ? "Connecting" : "Connect"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
