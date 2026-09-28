import { useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { useI18n } from "~/i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function BrowserSettingsSection() {
  const { t } = useI18n();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [apiKey, setApiKey] = useState("");
  const browser = settings.browserProvider;
  const configured = browser.browserbaseApiKeyRedacted === true;
  const canSave = apiKey.trim().length > 0;
  const agentAccess = settings.enableAgentBrowserAccess ?? true;

  return (
    <SettingsSection id="browser" title={t("Browser")}>
      <SettingsRow
        title="Browserbase"
        description={t(
          "Hosted browser sessions run in this environment and can be controlled from web, desktop, or remote clients.",
        )}
        status={
          browser.enabled ? t("Enabled") : configured ? t("Configured") : t("API key required")
        }
        control={
          <Switch
            aria-label={t("Enable Browserbase")}
            checked={browser.enabled}
            disabled={!configured && !browser.enabled}
            onCheckedChange={(checked) =>
              updateSettings({ browserProvider: { enabled: Boolean(checked) } })
            }
          />
        }
      />
      <SettingsRow
        title={t("API key")}
        description={t("Stored by the environment server. Add a key before enabling Browserbase.")}
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
            aria-label={t("Browserbase API key")}
            autoComplete="off"
            placeholder={
              configured ? t("Stored key - enter a new key to replace") : t("Browserbase API key")
            }
            spellCheck={false}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <Button disabled={!canSave} size="sm" type="submit">
            {t("Save")}
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
              {t("Remove")}
            </Button>
          ) : null}
        </form>
      </SettingsRow>
      <SettingsRow
        title={t("Agent browser access")}
        description={t(
          "Allow bots to use the in-app browser for research, previews, and interactive web tasks.",
        )}
        status={agentAccess ? t("Allowed") : t("Blocked")}
        control={
          <Switch
            aria-label={t("Allow agent browser access")}
            checked={agentAccess}
            onCheckedChange={(checked) =>
              updateSettings({ enableAgentBrowserAccess: Boolean(checked) })
            }
          />
        }
      />
      <SettingsRow
        title={t("How browser use works")}
        description={t(
          "Bots can open pages and inspect them in a sandboxed preview. Browserbase is only needed for hosted sessions.",
        )}
      >
        <div className="grid gap-2 pt-3 text-xs text-muted-foreground sm:grid-cols-3">
          <div className="rounded-lg border border-border/70 bg-background/50 p-3">
            <div className="font-medium text-foreground">{t("Research")}</div>
            <p className="mt-1">{t("Read public pages and gather context.")}</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background/50 p-3">
            <div className="font-medium text-foreground">{t("Preview")}</div>
            <p className="mt-1">{t("Inspect the app while you work together.")}</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background/50 p-3">
            <div className="font-medium text-foreground">{t("Hosted sessions")}</div>
            <p className="mt-1">{t("Use Browserbase when a remote browser is needed.")}</p>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
