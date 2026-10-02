import { ProjectId, ProviderInstanceId } from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { decideCommandSequence } from "./orchestration/decider.ts";
import {
  commandsForPortabilityImport,
  createPortabilityArchive,
  isPortabilityPreviewCurrent,
  normalizePortabilityProjectFolders,
  previewPortabilityImport,
} from "./portability.ts";

import {
  makeSnapshot,
  makeSettings,
  NOW,
  AVAILABLE_PROVIDER_IDS,
  PROJECT_ID,
  THREAD_ID,
  makePreflightSnapshot,
} from "./portabilityTestSupport.ts";

describe("portability import", () => {
  it("skips unmapped project records while applying independent records", () => {
    const archive = createPortabilityArchive(makeSnapshot(), makeSettings(), NOW);

    const target = makeSnapshot({
      projects: [],
      bots: [],
      groups: [],
      mcpServers: [],
      threads: [],
    });

    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(
      preview.unsupported.some((item) => item.kind === "project" || item.kind === "thread"),
    ).toBe(false);
    expect(preview.projectFolders).toEqual([
      {
        projectId: PROJECT_ID,
        title: "Portable project",
        workspaceName: "portable-project",
        destination: null,
      },
    ]);
    expect(plan.commands.map((command) => command.type)).toEqual(
      expect.arrayContaining(["mcp-server.create", "bot.create", "group.create"]),
    );
    expect(plan.commands.some((command) => command.type.startsWith("project."))).toBe(false);
    expect(plan.commands.some((command) => command.type.startsWith("thread."))).toBe(false);
    expect(plan.skipped).toBe(2);
  });

  it("creates projects and restores their threads into reviewed folders", () => {
    const source = makeSnapshot({
      projects: [{ ...makeSnapshot().projects[0]!, defaultThreadEnvMode: "worktree" }],
    });

    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const target = makeSnapshot({ projects: [], threads: [] });
    const projectFolders = { [PROJECT_ID]: "/tmp/restored-portable-project" };

    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
      projectFolders,
    );

    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
      projectFolders,
    );

    expect(preview.projectFolders).toEqual([
      expect.objectContaining({
        projectId: PROJECT_ID,
        destination: "/tmp/restored-portable-project",
      }),
    ]);
    expect(preview.additions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordType: "project", id: PROJECT_ID }),
        expect.objectContaining({ recordType: "thread", id: THREAD_ID }),
      ]),
    );
    expect(plan.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "project.create",
          projectId: PROJECT_ID,
          workspaceRoot: "/tmp/restored-portable-project",
        }),
        expect.objectContaining({
          type: "thread.create",
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
        }),
        expect.objectContaining({
          type: "project.meta.update",
          projectId: PROJECT_ID,
          defaultThreadEnvMode: "worktree",
        }),
      ]),
    );
    expect(plan.commands.findIndex((command) => command.type === "project.create")).toBeLessThan(
      plan.commands.findIndex((command) => command.type === "thread.create"),
    );
    expect(
      isPortabilityPreviewCurrent(
        target,
        makeSettings(),
        AVAILABLE_PROVIDER_IDS,
        preview,
        projectFolders,
      ),
    ).toBe(true);
    expect(
      isPortabilityPreviewCurrent(target, makeSettings(), AVAILABLE_PROVIDER_IDS, preview, {
        [PROJECT_ID]: "/tmp/other-folder",
      }),
    ).toBe(false);
  });

  it("skips threads when a mapped project needs a missing provider", () => {
    const sourceProject = makeSnapshot().projects[0]!;

    const source = makeSnapshot({
      projects: [
        {
          ...sourceProject,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("missing-project-provider"),
            model: "missing-model",
          },
        },
      ],
    });

    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const target = makeSnapshot({ projects: [], threads: [] });
    const projectFolders = { [PROJECT_ID]: "/tmp/restored-portable-project" };

    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
      projectFolders,
    );

    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
      projectFolders,
    );

    expect(preview.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordType: "project", id: PROJECT_ID }),
        expect.objectContaining({ recordType: "thread", id: THREAD_ID }),
      ]),
    );
    expect(plan.commands.some((command) => command.type.startsWith("project."))).toBe(false);
    expect(plan.commands.some((command) => command.type.startsWith("thread."))).toBe(false);
  });

  it("matches an already restored project by its imported ID", () => {
    const source = makeSnapshot();
    const archive = createPortabilityArchive(source, makeSettings(), NOW);

    const target = makeSnapshot({
      projects: [
        {
          ...source.projects[0]!,
          workspaceRoot: "/tmp/restored-under-a-new-name",
          repositoryIdentity: null,
        },
      ],
      threads: [],
    });

    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.projectFolders).toEqual([]);
    expect(plan.commands).not.toContainEqual(expect.objectContaining({ type: "project.create" }));
    expect(plan.commands).toContainEqual(
      expect.objectContaining({ type: "thread.create", projectId: PROJECT_ID }),
    );
  });

  it("restores a deleted same-ID project under a fresh ID", () => {
    const source = makeSnapshot();
    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const deletedProject = { ...source.projects[0]!, deletedAt: NOW };
    const target = makeSnapshot({ projects: [deletedProject], threads: [] });
    const projectFolders = { [PROJECT_ID]: "/tmp/restored-after-delete" };

    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
      projectFolders,
    );

    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
      projectFolders,
    );

    const createProject = plan.commands.find((command) => command.type === "project.create");

    expect(preview.additions).toContainEqual(
      expect.objectContaining({ recordType: "project", id: PROJECT_ID }),
    );
    expect(createProject).toEqual(
      expect.objectContaining({
        type: "project.create",
        workspaceRoot: "/tmp/restored-after-delete",
      }),
    );
    expect(createProject?.projectId).not.toBe(PROJECT_ID);
    expect(plan.commands).toContainEqual(
      expect.objectContaining({ type: "thread.create", projectId: createProject?.projectId }),
    );
  });

  effectIt.effect("preflights new project restores through the decider", () => {
    const source = makePreflightSnapshot();

    const target = makeSnapshot({
      projects: [],
      bots: [],
      groups: [],
      mcpServers: [],
      threads: [],
    });

    const commands = commandsForPortabilityImport(
      createPortabilityArchive(source, makeSettings(), NOW),
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
      { [PROJECT_ID]: "/tmp/restored-portable-project" },
    ).commands;

    return decideCommandSequence({ commands, readModel: target }).pipe(
      Effect.tap((events) =>
        Effect.sync(() => {
          expect(events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ type: "project.created" }),
              expect.objectContaining({ type: "thread.created" }),
            ]),
          );
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
  });

  it("rejects unsafe project folder maps", () => {
    const firstProject = makeSnapshot().projects[0]!;
    const secondProjectId = ProjectId.make("project-second");

    const source = makeSnapshot({
      projects: [
        firstProject,
        {
          ...firstProject,
          id: secondProjectId,
          title: "Second project",
          workspaceRoot: "/source/second-project",
          repositoryIdentity: null,
        },
      ],
    });

    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const target = makeSnapshot({ projects: [], threads: [] });

    expect(() =>
      normalizePortabilityProjectFolders(archive, target, {
        [PROJECT_ID]: "relative/project",
      }),
    ).toThrow("absolute path");
    expect(() =>
      normalizePortabilityProjectFolders(archive, target, {
        [PROJECT_ID]: "/tmp/restored",
        [secondProjectId]: "/tmp/restored/",
      }),
    ).toThrow("same destination");
  });
});
