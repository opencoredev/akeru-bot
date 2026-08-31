import type { Bot } from "./types";

export const BOT_SANDBOX_OPTIONS = [
  { value: "local", label: "Local" },
  { value: "e2b", label: "E2B" },
  { value: "daytona", label: "Daytona" },
  { value: "vercel", label: "Vercel Sandbox" },
  { value: "upstash", label: "Upstash Box" },
] as const;

export type BotSandboxChoice = (typeof BOT_SANDBOX_OPTIONS)[number]["value"];

export function botSandboxChoice(sandbox: Bot["sandbox"]): BotSandboxChoice {
  return sandbox ?? "local";
}

export function botSandboxLabel(sandbox: BotSandboxChoice): string {
  return BOT_SANDBOX_OPTIONS.find((option) => option.value === sandbox)?.label ?? "Local";
}
