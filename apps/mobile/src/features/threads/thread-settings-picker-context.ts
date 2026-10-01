import type { EnvironmentId, ThreadId } from "@akeru/contracts";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createContext, use } from "react";
import type {
  ThreadSettingsSessionProps,
  ThreadSettingsSubmenuPage,
} from "./thread-settings-session";

export type ThreadSettingsPickerStackParams = {
  ThreadSettingsModels: undefined;
  ThreadSettingsChoice: ThreadSettingsSubmenuPage & { readonly title: string };
  ThreadSettingsMemory: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
  ThreadSettingsRoutines: NonNullable<ThreadSettingsSessionProps["routinesRef"]>;
};

export type ThreadSettingsPickerPresentation = {
  readonly onClose: () => void;
};

export const ThreadSettingsPickerStack =
  createNativeStackNavigator<ThreadSettingsPickerStackParams>();

export const ThreadSettingsPickerPresentationContext =
  createContext<ThreadSettingsPickerPresentation | null>(null);

export function useThreadSettingsPickerPresentation() {
  const value = use(ThreadSettingsPickerPresentationContext);

  if (!value) {
    throw new Error(
      "useThreadSettingsPickerPresentation must be used inside ThreadSettingsPickerNavigator.",
    );
  }

  return value;
}
