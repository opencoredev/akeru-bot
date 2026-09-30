import { squashAtomCommandFailure } from "@akeru/client-runtime/state/runtime";
import type { EnvironmentId, SandboxProvider, SandboxSettings } from "@akeru/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  canSaveSandboxProviderConnection,
  applyRailwayConnectionChange,
  type RailwayConnectionChange,
  type CloudSandboxProvider,
  disconnectSandboxProvider,
  isSandboxProviderConnected,
  SANDBOX_PROVIDER_DEFINITIONS,
  sandboxConnectionDraft,
  sandboxProviderDefinition,
  saveSandboxProviderConnection,
  selectableSandboxProviders,
} from "./SandboxSettingsPanel.logic";
import { useI18n } from "../../i18n";

// Cloud entries are brand names; `local` is translated at render time.
const SANDBOX_PROVIDER_LABELS: Readonly<Record<SandboxProvider, string>> = {
  local: "Local",
  e2b: "E2B",
  daytona: "Daytona",
  vercel: "Vercel Sandbox",
  upstash: "Upstash Box",
  ascii: "Ascii Box",
  railway: "Railway",
  tenki: "Tenki",
};

function errorMessage(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function SandboxSettingsPanel() {
  const { t } = useI18n();
  const environmentId = useSettingsEnvironmentId();
  if (environmentId === null) {
    return (
      <SettingsSection title={t("Sandbox")}>
        <SettingsRow title={t("Connect to an environment first.")} />
      </SettingsSection>
    );
  }
  return <EnvironmentSandboxSettingsPanel key={environmentId} environmentId={environmentId} />;
}

function EnvironmentSandboxSettingsPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { t } = useI18n();
  const sandbox = useEnvironmentSettings(environmentId, (settings) => settings.sandbox);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [editingProvider, setEditingProvider] = useState<CloudSandboxProvider | null>(null);
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [railwayChange, setRailwayChange] = useState<RailwayConnectionChange | null>(null);

  const persist = async (next: SandboxSettings) => {
    setSaving(true);
    setError(null);
    const result = await updateSettings({ environmentId, input: { patch: { sandbox: next } } });
    setSaving(false);
    if (result._tag === "Failure") {
      setError(errorMessage(result, t("The server rejected these sandbox settings.")));
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
    if (editingProvider === "railway" && isSandboxProviderConnected(sandbox, "railway")) {
      setRailwayChange({ kind: "save", draft: { ...draft } });
      return;
    }
    if (await persist(next)) closeConnection();
  };

  const editingDefinition = editingProvider ? sandboxProviderDefinition(editingProvider) : null;
  const providerLabel = (provider: SandboxProvider) =>
    provider === "local" ? t("Local") : SANDBOX_PROVIDER_LABELS[provider];
  const canSave =
    editingProvider !== null &&
    canSaveSandboxProviderConnection({ settings: sandbox, provider: editingProvider, draft });

  return (
    <>
      <SettingsSection {...searchableSetting("sandbox", t)}>
        <SettingsRow
          {...searchableSetting("default-sandbox", t)}
          description={t("Bots without an override use this sandbox.")}
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
              <SelectTrigger className="w-44" aria-label={t("Default sandbox")}>
                <SelectValue>{providerLabel(sandbox.defaultProvider)}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {selectableSandboxProviders(sandbox).map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {providerLabel(provider)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("sandbox-auto-idle", t)}
          description={t(
            "Akeru pauses idle remote sandboxes when supported. Railway VMs keep running until cleanup.",
          )}
          control={<Switch checked disabled aria-label={t("Auto-idle")} />}
        />
      </SettingsSection>

      <SettingsSection title={t("Sandbox providers")}>
        <SettingsRow
          title={t("Local")}
          description={t(
            "Run bots on the environment computer. Always available; no credentials needed.",
          )}
          status={t("Available")}
        />
        {SANDBOX_PROVIDER_DEFINITIONS.map((definition) => {
          const connected = isSandboxProviderConnected(sandbox, definition.id);
          return (
            <SettingsRow
              key={definition.id}
              title={definition.label}
              description={t(definition.description)}
              status={connected ? t("Connected") : t("Not connected")}
              control={
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={saving}
                    aria-label={
                      connected
                        ? t("Edit {name}", { name: definition.label })
                        : t("Connect {name}", { name: definition.label })
                    }
                    onClick={() => openConnection(definition.id)}
                  >
                    {connected ? t("Edit") : t("Connect")}
                  </Button>
                  {connected ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      aria-label={t("Disconnect {name}", { name: definition.label })}
                      disabled={saving}
                      onClick={() => {
                        if (definition.id === "railway") setRailwayChange({ kind: "disconnect" });
                        else void persist(disconnectSandboxProvider(sandbox, definition.id));
                      }}
                    >
                      {t("Disconnect")}
                    </Button>
                  ) : null}
                </div>
              }
            />
          );
        })}
      </SettingsSection>

      <Dialog
        open={editingProvider !== null && railwayChange === null}
        onOpenChange={(open) => !open && closeConnection()}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {editingDefinition
                ? isSandboxProviderConnected(sandbox, editingDefinition.id)
                  ? t("Edit {name}", { name: editingDefinition.label })
                  : t("Connect {name}", { name: editingDefinition.label })
                : t("Connect sandbox")}
            </DialogTitle>
            <DialogDescription>
              {t("The server stores these credentials in its secret store.")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            {editingDefinition?.fields.map((field) => (
              <label key={field.name} className="grid gap-1.5 text-sm font-medium">
                {t(field.label)}
                <Input
                  type={field.secret ? "password" : undefined}
                  autoComplete="off"
                  value={draft[field.name] ?? ""}
                  placeholder={field.secret ? t("Leave blank to keep the saved value") : undefined}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((current) => ({ ...current, [field.name]: value }));
                  }}
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
              {t("Cancel")}
            </Button>
            <Button disabled={!canSave || saving} onClick={() => void saveConnection()}>
              {saving
                ? t("Saving…")
                : editingDefinition && isSandboxProviderConnected(sandbox, editingDefinition.id)
                  ? t("Save changes")
                  : t("Connect")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={railwayChange !== null}
        onOpenChange={(open) => !open && !saving && setRailwayChange(null)}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t("Retire Railway VMs before changing access")}</DialogTitle>
            <DialogDescription>
              {t(
                "Changing or removing credentials does not stop or delete Railway VMs. They can keep accruing charges. Stop active bot sessions, then open your environment in the Railway dashboard and destroy any VMs you no longer need before removing access. If you are rotating a token, keep access to the same environment to reconnect to existing VMs. Akeru preserves saved VM identities and will not silently create replacements.",
              )}
            </DialogDescription>
          </DialogHeader>
          <a
            href="https://railway.com/dashboard"
            target="_blank"
            rel="noreferrer"
            className="text-sm underline"
          >
            {t("Open Railway dashboard")}
          </a>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setRailwayChange(null)}>
              {t("Cancel")}
            </Button>
            <Button
              disabled={saving}
              onClick={async () => {
                if (
                  railwayChange &&
                  (await persist(applyRailwayConnectionChange(sandbox, railwayChange)))
                ) {
                  setRailwayChange(null);
                  closeConnection();
                }
              }}
            >
              {t("I have reviewed my VMs — continue")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
