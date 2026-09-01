import { useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function BrowserSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [apiKey, setApiKey] = useState("");
  const browser = settings.browserProvider;
  const configured = browser.browserbaseApiKeyRedacted === true;
  const canSave = apiKey.trim().length > 0;

  return (
    <SettingsPageContainer>
      <SettingsSection id="browser" title="Browser">
        <SettingsRow
          title="Browserbase"
          description="Give agents a hosted browser they can use from any client."
          status={browser.enabled ? "Enabled" : configured ? "Configured" : "API key required"}
          control={
            <Switch
              aria-label="Enable Browserbase"
              checked={browser.enabled}
              onCheckedChange={(checked) =>
                updateSettings({ browserProvider: { enabled: Boolean(checked) } })
              }
            />
          }
        />
        <SettingsRow title="API key" description="Stored securely on this T3 server.">
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
      </SettingsSection>
    </SettingsPageContainer>
  );
}
