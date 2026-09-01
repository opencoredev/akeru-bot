import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AKERU_PRIVACY_POLICY_VERSION, AKERU_TERMS_VERSION } from "@t3tools/contracts/settings";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { AsyncResult } from "effect/unstable/reactivity";
import { type ColorValue, Modal, Pressable, View } from "react-native";

import { AppText } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "./lib/legal-document-url";
import {
  needsMobilePolicyAcknowledgement,
  shouldShowMobilePolicyNotice,
} from "./MobilePolicyNotice.logic";

export function MobilePolicyNotice() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const pressedOverlay = useThemeColor("--color-subtle");
  const loaded = AsyncResult.isSuccess(preferences);
  const appVariant =
    (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "development";
  const visible = shouldShowMobilePolicyNotice({
    appVariant,
    loaded,
    needsAcknowledgement: loaded && needsMobilePolicyAcknowledgement(preferences.value),
  });

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View className="flex-1 items-center justify-center bg-backdrop px-8">
        <View className="w-full rounded-[24px] bg-card px-6 pb-4 pt-5">
          <AppText className="text-lg font-t3-medium">Review Akeru Bot policies</AppText>
          <AppText className="mt-2 text-sm text-foreground-secondary">
            Akeru Bot runs locally. Provider prompts and enabled online features still send data to
            their listed services.
          </AppText>
          <View className="mt-5 flex-row flex-wrap justify-end gap-1">
            <PolicyButton
              label="Terms of Use"
              onPress={() => void Linking.openURL(TERMS_OF_SERVICE_URL).catch(() => undefined)}
              pressedOverlay={pressedOverlay}
            />
            <PolicyButton
              label="Privacy Policy"
              onPress={() => void Linking.openURL(PRIVACY_POLICY_URL).catch(() => undefined)}
              pressedOverlay={pressedOverlay}
            />
            <PolicyButton
              label="I reviewed these drafts"
              onPress={() =>
                updatePreferences({
                  reviewedPrivacyPolicyVersion: AKERU_PRIVACY_POLICY_VERSION,
                  reviewedTermsVersion: AKERU_TERMS_VERSION,
                })
              }
              pressedOverlay={pressedOverlay}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function PolicyButton({
  label,
  onPress,
  pressedOverlay,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly pressedOverlay: ColorValue;
}) {
  return (
    <View className="overflow-hidden rounded-full">
      <Pressable
        accessibilityRole="button"
        className="min-h-10 items-center justify-center px-4"
        android_ripple={{ color: pressedOverlay }}
        onPress={onPress}
      >
        <AppText className="text-base font-t3-medium">{label}</AppText>
      </Pressable>
    </View>
  );
}
