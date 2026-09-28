import { availableLanguages, useI18n } from "../../i18n";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function LanguageSetting() {
  const { t, preference, setPreference, catalogFailed, retryCatalog } = useI18n();
  const selectedLabel =
    availableLanguages.find((language) => language.id === preference)?.label ?? t("System default");
  return (
    <SettingsRow
      {...searchableSetting("language", t)}
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
        <Select
          value={preference}
          onValueChange={(value) => {
            if (typeof value === "string") setPreference(value);
          }}
        >
          <SelectTrigger
            id="language-preference"
            aria-describedby="language-description"
            className="w-full sm:w-48"
          >
            <SelectValue>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="system">
              {t("System default")}
            </SelectItem>
            {availableLanguages.map(({ id, label }) => (
              <SelectItem hideIndicator key={id} value={id}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
