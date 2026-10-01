import type { EnvironmentThreadShell } from "@akeru/client-runtime/state/shell";
import { Platform } from "react-native";
import { relativeTime } from "../../lib/time";

/**
 * Thread List v2 renders one flat native list: rich edge-to-edge rows for
 * active work and a receded settled tail, all with native swipe and
 * long-press actions. State reads through colored status labels and text
 * hierarchy rather than card fills.
 */

/** Bot-style display name for rows whose thread has no configured bot. */
const PROVIDER_BOT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  opencode: "OpenCode",
  opencodeGo: "OpenCode",
};

/**
 * Display name for a thread that has no configured bot. Returns null until the
 * provider is known so callers can pick their own wording rather than show a
 * generic "Bot".
 */
export function providerBotName(driver: string | null): string | null {
  if (!driver) return null;

  return PROVIDER_BOT_NAMES[driver] ?? driver.charAt(0).toUpperCase() + driver.slice(1);
}

export const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

/** Relative time shown on a v2 row. Parents compute it on their minute tick. */
export function threadListV2TimeLabel(thread: EnvironmentThreadShell): string {
  return relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt);
}

/** Rounded-row radius shared with the v1 sidebar rows. */
export const SIDEBAR_V2_ROW_RADIUS = 12;
