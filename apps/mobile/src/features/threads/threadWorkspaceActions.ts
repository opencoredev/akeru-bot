/**
 * Workspace tools for one chat: files, terminal, git, and the inspector
 * toggle. The chat header stays focused on the bot, so these live behind a
 * single overflow control instead of a row of icons. Project-backed chats
 * gate each entry the same way the git toolbar does; a chat with no project
 * gets an empty list and the control is not rendered at all.
 */
export type ThreadWorkspaceAction = {
  readonly id: "files" | "terminal" | "git" | "inspector";
  readonly title: string;
  /** SF Symbol / Material name, matching the other mobile menus. */
  readonly image: string;
};

export function buildThreadWorkspaceActions(input: {
  readonly canOpenFiles: boolean;
  readonly canOpenTerminal: boolean;
  readonly canOpenGit: boolean;
  readonly canToggleInspector: boolean;
}): ReadonlyArray<ThreadWorkspaceAction> {
  const actions: ThreadWorkspaceAction[] = [];
  if (input.canOpenFiles) {
    actions.push({ id: "files", title: "Files", image: "folder" });
  }
  if (input.canOpenTerminal) {
    actions.push({ id: "terminal", title: "Terminal", image: "terminal" });
  }
  if (input.canOpenGit) {
    actions.push({
      id: "git",
      title: "Git actions",
      image: "point.topleft.down.curvedto.point.bottomright.up",
    });
  }
  if (input.canToggleInspector) {
    actions.push({ id: "inspector", title: "Toggle inspector", image: "sidebar.right" });
  }
  return actions;
}

/**
 * Routes one overflow selection to the screen's existing handlers. Kept apart
 * from the screen so the mapping can be proven without mounting the route.
 */
export function runThreadWorkspaceAction(
  id: ThreadWorkspaceAction["id"],
  handlers: {
    readonly openFiles: () => void;
    readonly openTerminal: () => void;
    readonly openGit: () => void;
    readonly toggleInspector: () => void;
  },
): void {
  if (id === "files") return handlers.openFiles();
  if (id === "terminal") return handlers.openTerminal();
  if (id === "git") return handlers.openGit();
  return handlers.toggleInspector();
}
