import {
  DEFAULT_LOCAL_EXECUTION_MODE,
  type LocalExecutionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { createTranslator } from "@t3tools/client-runtime/i18n";

import type { useI18n } from "../../i18n";
import type { Bot } from "./types";

type Translate = ReturnType<typeof useI18n>["t"];

const translateEnglish: Translate = createTranslator("en").translate;

export const DEFAULT_BOT_RUNTIME_MODE: RuntimeMode = DEFAULT_LOCAL_EXECUTION_MODE;

export const BOT_SANDBOX_OPTIONS = [
  { value: "local", label: "Local" },
  { value: "e2b", label: "E2B" },
  { value: "daytona", label: "Daytona" },
  { value: "vercel", label: "Vercel Sandbox" },
  { value: "upstash", label: "Upstash Box" },
  { value: "ascii", label: "Ascii Box" },
] as const;

export type BotSandboxChoice = (typeof BOT_SANDBOX_OPTIONS)[number]["value"];

export function botSandboxChoice(sandbox: Bot["sandbox"]): BotSandboxChoice {
  return sandbox ?? "local";
}

/** "Local" is interface copy; the cloud sandbox labels are product names and stay as written. */
export function botSandboxLabel(
  sandbox: BotSandboxChoice,
  t: Translate = translateEnglish,
): string {
  const option = BOT_SANDBOX_OPTIONS.find((candidate) => candidate.value === sandbox);
  return !option || option.value === "local" ? t("Local") : option.label;
}

export function resolveBotRuntimeMode(
  sandbox: Bot["sandbox"],
  localExecutionMode: LocalExecutionMode,
): RuntimeMode {
  return botSandboxChoice(sandbox) === "local" ? localExecutionMode : "full-access";
}
