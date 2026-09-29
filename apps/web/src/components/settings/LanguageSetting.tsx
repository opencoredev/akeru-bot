import { availableLanguages, useI18n } from "../../i18n";
import { Button } from "../ui/button";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function LanguageSetting() {
  const { t, preference, setPreference, catalogFailed, retryCatalog } = useI18n();
  return (
    <SettingsRow
      {...searchableSetting("language")}
      title={<label htmlFor="language-preference">{t("Language")}</label>}
      description={
        <span id="language-description">
          {t("Language applies only to this device.")}{" "}
          {t("English and Simplified Chinese are available.")}{" "}
          {t("User messages and bot responses are not translated.")}
        </span>
      }
      status={
        catalogFailed ? (
          <span role="alert" className="inline-flex flex-wrap items-center gap-2">
            {t("The selected language could not load, so English is shown.")}
            <Button size="xs" variant="outline" onClick={retryCatalog}>
              {t("Try again")}
            </Button>
          </span>
        ) : undefined
      }
      resetAction={
        <SettingResetButton
          label={t("Language")}
          disabled={preference === "system"}
          onClick={() => setPreference("system")}
        />
      }
      control={
        <select
          id="language-preference"
          aria-describedby="language-description"
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-48"
          value={preference}
          onChange={(event) => setPreference(event.currentTarget.value)}
        >
          <option value="system">{t("System default")}</option>
          {availableLanguages.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      }
    />
  );
}
