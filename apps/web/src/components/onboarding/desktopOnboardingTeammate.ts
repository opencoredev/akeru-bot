export const DESKTOP_ONBOARDING_TEAMMATE_NAMES = [
  "Nova",
  "Scout",
  "Dispatch",
  "Mira",
  "Atlas",
  "Rowan",
  "Sage",
  "Quinn",
  "Harbor",
  "Vesper",
  "Kit",
  "Wren",
] as const;

export interface DesktopOnboardingPromptChip {
  readonly id: "code" | "research" | "admin" | "planning";
  readonly label: string;
  readonly prompt: string;
}

/** Empty first-chat suggestions. Click fills the composer; none of them send. */
export const DESKTOP_ONBOARDING_PROMPT_CHIPS: readonly DesktopOnboardingPromptChip[] = [
  {
    id: "code",
    label: "Ship a feature",
    prompt: "Walk this codebase and ship a small, complete improvement.",
  },
  {
    id: "research",
    label: "Research",
    prompt: "Research a topic for me and keep one page of findings current",
  },
  {
    id: "admin",
    label: "Admin",
    prompt: "Take the admin off my desk: inbox, invoices, and filing",
  },
  {
    id: "planning",
    label: "Plan my week",
    prompt: "Plan my week and keep me on top of what I said I would do",
  },
];

export const DESKTOP_ONBOARDING_FIRST_CHAT_STORAGE_KEY = "akeru:desktop-onboarding-first-chat:v1";

export function pickDesktopOnboardingTeammateName(
  takenNames: ReadonlyArray<string>,
  random: () => number = Math.random,
): string {
  const taken = new Set(takenNames.map((name) => name.trim().toLocaleLowerCase()));

  const available = DESKTOP_ONBOARDING_TEAMMATE_NAMES.filter(
    (name) => !taken.has(name.toLocaleLowerCase()),
  );

  const pool = available.length > 0 ? available : DESKTOP_ONBOARDING_TEAMMATE_NAMES;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));

  return pool[index] ?? "Nova";
}

export function workspaceTitleFromCwd(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[/\\]/).filter(Boolean);

  return segments.at(-1) || "project";
}

export function desktopOnboardingDefaultProjectCreateInput(input: {
  readonly bootstrapped: boolean;
  readonly projectCount: number;
  readonly cwd: string | null;
  readonly projectId: string;
}): { readonly projectId: string; readonly title: string; readonly workspaceRoot: string } | null {
  const cwd = input.cwd?.trim() ?? "";

  if (!input.bootstrapped || input.projectCount > 0 || cwd.length === 0) return null;

  return {
    projectId: input.projectId,
    title: workspaceTitleFromCwd(cwd),
    workspaceRoot: cwd,
  };
}

export function markDesktopOnboardingFirstChat(
  storage: Pick<Storage, "setItem">,
  botId: string,
): void {
  storage.setItem(DESKTOP_ONBOARDING_FIRST_CHAT_STORAGE_KEY, botId);
}

export function readDesktopOnboardingFirstChatBotId(storage: Pick<Storage, "getItem">): string | null {
  const value = storage.getItem(DESKTOP_ONBOARDING_FIRST_CHAT_STORAGE_KEY)?.trim();

  return value && value.length > 0 ? value : null;
}

export function clearDesktopOnboardingFirstChat(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(DESKTOP_ONBOARDING_FIRST_CHAT_STORAGE_KEY);
}

export function shouldShowDesktopOnboardingPromptChips(input: {
  readonly desktop: boolean;
  readonly botId: string;
  readonly firstChatBotId: string | null;
  readonly hasMessages: boolean;
  readonly composerEmpty: boolean;
}): boolean {
  return (
    input.desktop &&
    !input.hasMessages &&
    input.composerEmpty &&
    input.firstChatBotId === input.botId
  );
}
