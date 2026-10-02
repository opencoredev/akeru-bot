import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeUtil from "node:util";
import {
  BASE_ENVIRONMENT_PRESENCE,
  UPDATED_ENVIRONMENT_PRESENCE,
  REMOTE_HANDOFF_CARD,
  SHOWCASE_PROJECTS,
  SHOWCASE_THREADS,
  SHOWCASE_PROJECT_ID,
} from "./mobile-showcase-fixtures.ts";
import { waitForSeedableSchema, seedDatabase } from "./mobile-showcase-seed-database.ts";

export { SHOWCASE_PROJECT_ID } from "./mobile-showcase-fixtures.ts";

export { SHOWCASE_THREAD_ID } from "./mobile-showcase-fixtures.ts";

export { SHOWCASE_SCENES } from "./mobile-showcase-fixtures.ts";

export type { ShowcaseScene } from "./mobile-showcase-fixtures.ts";

export { SHOWCASE_PROJECTS } from "./mobile-showcase-fixtures.ts";

export { SHOWCASE_ENVIRONMENTS } from "./mobile-showcase-fixtures.ts";

export { SHOWCASE_THREADS } from "./mobile-showcase-fixtures.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

async function runGit(workspaceRoot: string, args: ReadonlyArray<string>): Promise<void> {
  await execFile("git", [...args], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Alex Rivera",
      GIT_AUTHOR_EMAIL: "alex@lumen.test",
      GIT_COMMITTER_NAME: "Alex Rivera",
      GIT_COMMITTER_EMAIL: "alex@lumen.test",
    },
  });
}

async function initializeRepository(input: {
  readonly workspaceRoot: string;
  readonly repositoryUrl: string;
  readonly commitMessage: string;
}): Promise<void> {
  await runGit(input.workspaceRoot, ["init", "-b", "main"]);
  await runGit(input.workspaceRoot, ["remote", "add", "origin", input.repositoryUrl]);
  await runGit(input.workspaceRoot, ["add", "."]);
  await runGit(input.workspaceRoot, ["commit", "-m", input.commitMessage]);
}

async function seedT3CodeWorkspace(workspaceRoot: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.join(workspaceRoot, "apps/mobile/src/features/home"), {
    recursive: true,
  });
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "package.json"),
    `${JSON.stringify({ name: "t3code", private: true, scripts: { test: "vp test" } }, null, 2)}\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/environmentPresence.ts"),
    BASE_ENVIRONMENT_PRESENCE,
  );
  await initializeRepository({
    workspaceRoot,
    repositoryUrl: "https://github.com/opencoredev/akeru-bot.git",
    commitMessage: "Show connected environments",
  });
  await runGit(workspaceRoot, ["checkout", "-b", "feat/remote-command-center"]);
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/environmentPresence.ts"),
    UPDATED_ENVIRONMENT_PRESENCE,
  );
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "apps/mobile/src/features/home/RemoteHandoffCard.tsx"),
    REMOTE_HANDOFF_CARD,
  );
}

async function seedCompanionWorkspace(input: {
  readonly workspaceRoot: string;
  readonly title: string;
  readonly repositoryUrl: string;
}): Promise<void> {
  await NodeFSP.mkdir(input.workspaceRoot, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(input.workspaceRoot, "README.md"),
    `# ${input.title}\n\nSeeded by the Akeru Bot mobile screenshot harness.\n`,
  );
  await initializeRepository({
    workspaceRoot: input.workspaceRoot,
    repositoryUrl: input.repositoryUrl,
    commitMessage: `Seed ${input.title} workspace`,
  });
}

export async function seedShowcaseEnvironment(input: {
  readonly baseDir: string;
  readonly projectIds?: ReadonlyArray<string>;
  readonly now?: number;
}): Promise<{ readonly dbPath: string; readonly workspaceRoot: string }> {
  const now = input.now ?? Date.now();

  const selectedProjectIds = new Set(
    input.projectIds ?? SHOWCASE_PROJECTS.map((project) => project.id),
  );

  const projects = SHOWCASE_PROJECTS.filter((project) => selectedProjectIds.has(project.id));

  if (projects.length === 0) throw new Error("At least one showcase project must be selected.");
  const threads = SHOWCASE_THREADS.filter((thread) => selectedProjectIds.has(thread.projectId));
  const workspaceBase = NodePath.join(input.baseDir, "workspace");

  const workspaceRoots = new Map(
    projects.map(
      (project) => [project.id, NodePath.join(workspaceBase, project.directory)] as const,
    ),
  );

  const primaryProject =
    projects.find((project) => project.id === SHOWCASE_PROJECT_ID) ?? projects[0];

  if (!primaryProject) throw new Error("The primary showcase workspace is not configured.");
  const workspaceRoot = workspaceRoots.get(primaryProject.id);

  if (!workspaceRoot) throw new Error("The primary showcase workspace is not configured.");
  const dbPath = NodePath.join(input.baseDir, "userdata", "state.sqlite");

  if (primaryProject.id === SHOWCASE_PROJECT_ID) {
    await seedT3CodeWorkspace(workspaceRoot);
  }

  await Promise.all(
    projects
      .filter((project) => project.id !== SHOWCASE_PROJECT_ID)
      .map(async (project) => {
        const projectWorkspaceRoot = workspaceRoots.get(project.id);

        if (!projectWorkspaceRoot) throw new Error(`Missing workspace root for ${project.id}.`);
        await seedCompanionWorkspace({
          workspaceRoot: projectWorkspaceRoot,
          title: project.title,
          repositoryUrl: project.repositoryUrl,
        });
      }),
  );
  // The environment server begins listening before it finishes migrating the
  // database, so wait for the schema before deleting from and reseeding it.
  await waitForSeedableSchema(dbPath);
  seedDatabase(dbPath, workspaceRoots, projects, threads, now);

  return { dbPath, workspaceRoot };
}
