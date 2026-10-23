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
