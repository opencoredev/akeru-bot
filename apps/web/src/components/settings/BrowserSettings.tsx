import { useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function BrowserSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [apiKey, setApiKey] = useState("");
  const browser = settings.browserProvider;
  const configured = browser.browserbaseApiKeyRedacted === true;
  const canSave = apiKey.trim().length > 0;
  const agentAccess = settings.enableAgentBrowserAccess ?? true;

  return (
    <SettingsSection id="browser" title="Browser">
      <SettingsRow
        title="Browserbase"
        description="Hosted browser sessions run in this environment and can be controlled from web, desktop, or remote clients."
        status={browser.enabled ? "Enabled" : configured ? "Configured" : "API key required"}
        control={
          <Switch
            aria-label="Enable Browserbase"
            checked={browser.enabled}
            disabled={!configured && !browser.enabled}
            onCheckedChange={(checked) =>
              updateSettings({ browserProvider: { enabled: Boolean(checked) } })
            }
          />
        }
      />
      <SettingsRow
        title="API key"
        description="Stored by the environment server. Add a key before enabling Browserbase."
      >
        <form
          className="flex items-center gap-2 pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            const nextApiKey = apiKey.trim();
            if (!nextApiKey) return;
            updateSettings({
              browserProvider: {
                browserbaseApiKey: nextApiKey,
                browserbaseApiKeyRedacted: false,
              },
            });
            setApiKey("");
          }}
        >
          <Input
            aria-label="Browserbase API key"
            autoComplete="off"
            placeholder={
              configured ? "Stored key - enter a new key to replace" : "Browserbase API key"
            }
            spellCheck={false}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <Button disabled={!canSave} size="sm" type="submit">
            Save
          </Button>
          {configured ? (
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() =>
                updateSettings({
                  browserProvider: {
                    enabled: false,
                    browserbaseApiKey: "",
                    browserbaseApiKeyRedacted: false,
                  },
                })
              }
            >
              Remove
            </Button>
          ) : null}
        </form>
      </SettingsRow>
      <SettingsRow
        title="Agent browser access"
        description="Allow bots to use the in-app browser for research, previews, and interactive web tasks."
        status={agentAccess ? "Allowed" : "Blocked"}
        control={
          <Switch
            aria-label="Allow agent browser access"
            checked={agentAccess}
            onCheckedChange={(checked) =>
              updateSettings({ enableAgentBrowserAccess: Boolean(checked) })
            }
          />
        }
      />
      <SettingsRow
        title="How browser use works"
        description="Bots can open pages and inspect them in a sandboxed preview. Browserbase is only needed for hosted sessions."
      >
        <div className="grid gap-2 pt-3 text-xs text-muted-foreground sm:grid-cols-3">
          <div className="rounded-lg border border-border/70 bg-background/50 p-3">
            <div className="font-medium text-foreground">Research</div>
            <p className="mt-1">Read public pages and gather context.</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background/50 p-3">
            <div className="font-medium text-foreground">Preview</div>
            <p className="mt-1">Inspect the app while you work together.</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background/50 p-3">
            <div className="font-medium text-foreground">Hosted sessions</div>
            <p className="mt-1">Use Browserbase when a remote browser is needed.</p>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
