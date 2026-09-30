import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { availableLanguages } from "@akeru/client-runtime/i18n";
import { AsyncResult } from "effect/unstable/reactivity";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";

export function LanguageSettingsSection() {
  const { t, preference, catalogFailed, retryCatalog } = useMobileI18n();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const result = useAtomValue(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const options = [{ id: "system", label: t("System default") }, ...availableLanguages];

  return (
    <View className="gap-3">
      <SettingsSection title={t("Language")}>
        {options.map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityHint={
              option.id === "system"
                ? t("Use the language of this device")
                : t("Use {language}", { language: option.label })
            }
            accessibilityState={{ checked: preference === option.id, disabled: !ready }}
            disabled={!ready}
            onPress={() => save({ language: option.id })}
            className="flex-row items-center justify-between p-4"
          >
            <Text className="text-lg text-foreground">{option.label}</Text>
            {preference === option.id ? (
              <Text
                accessibilityElementsHidden
                importantForAccessibility="no"
                className="text-lg text-foreground"
              >
                ✓
              </Text>
            ) : null}
          </Pressable>
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {t(
          "Saved on this device only. System default follows this device when English or Simplified Chinese is available.",
        )}
      </Text>
      {catalogFailed ? (
        <View accessibilityRole="alert" className="flex-row flex-wrap items-center gap-3 px-2">
          <Text className="text-sm text-foreground">
            {t("The selected language could not load, so English is shown.")}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={retryCatalog}
            className="py-1 active:opacity-60"
          >
            <Text className="text-sm font-t3-medium text-foreground">{t("Try again")}</Text>
          </Pressable>
        </View>
      ) : null}
      {AsyncResult.isFailure(result) ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-foreground">
          {t("Could not save preferences. Try again.")}
        </Text>
      ) : null}
    </View>
  );
}
