import { Match } from "effect";
import type { AuthClientPresentationMetadata } from "@akeru/contracts";
import * as Device from "expo-device";
import { Platform } from "react-native";

export function authClientMetadata(appVersion?: string): AuthClientPresentationMetadata {
  const osMajorVersion = Number.parseInt(Device.osVersion?.split(".")[0] ?? "", 10);
  const deviceModel = Device.modelName?.trim();

  return {
    label: "Akeru Bot Mobile",
    deviceType: "mobile",
    ...Match.value(Platform.OS).pipe(
      Match.when("ios", () => ({ os: "iOS" })),
      Match.when("android", () => ({ os: "Android" })),
      Match.orElse(() => ({})),
    ),
    ...(Number.isFinite(osMajorVersion) && osMajorVersion > 0 ? { osMajorVersion } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    surface: "mobile",
    ...(appVersion ? { appVersion } : {}),
  };
}
