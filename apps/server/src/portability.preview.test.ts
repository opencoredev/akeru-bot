import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
import { commandsForPortabilityImport, createPortabilityArchive, isPortabilityPreviewCurrent, previewPortabilityImport } from "./portability.ts";

import { makeSnapshot, makeSettings, NOW, AVAILABLE_PROVIDER_IDS, THREAD_ID, LATER, PROJECT_ID, URL_MCP_ID, STDIO_MCP_ID } from "./portabilityTestSupport.ts";

describe("portability import", () => {

  it("conflicts with different existing conversation history", () => {
    const source = makeSnapshot();
    const target = makeSnapshot({
      threads: [
        {
          ...makeSnapshot().threads[0]!,
          messages: [
            {
              ...makeSnapshot().threads[0]!.messages[0]!,
              text: "Target-only conversation",
            },
          ],
          proposedPlans: [],
          activities: [],
        },
      ],
    });
    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const preview = previewPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.conflicts).toContainEqual(
      expect.objectContaining({ recordType: "thread", id: THREAD_ID }),
    );
    expect(
      commandsForPortabilityImport(archive, target, makeSettings(), AVAILABLE_PROVIDER_IDS)
        .commands,
    ).not.toContainEqual(expect.objectContaining({ type: "thread.history.restore" }));
  });


  it("does not overwrite newer server settings", () => {
    const preview = previewPortabilityImport(
      createPortabilityArchive(makeSnapshot(), makeSettings(), NOW),
      makeSnapshot({ updatedAt: LATER }),
      DEFAULT_SERVER_SETTINGS,
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.conflicts).toContainEqual({
      recordType: "server-settings",
      id: "server-settings",
      title: "Server settings",
    });
  });


  it("updates safe project fields only when the workspace reference matches", () => {
    const sourceProject = {
      ...makeSnapshot().projects[0]!,
      title: "Renamed portable project",
      defaultThreadEnvMode: "worktree" as const,
      updatedAt: LATER,
    };
    const source = makeSnapshot({ projects: [sourceProject], updatedAt: LATER });
    const archive = createPortabilityArchive(source, makeSettings(), LATER);
    const target = makeSnapshot();
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

    expect(preview.changes).toContainEqual(
      expect.objectContaining({ recordType: "project", id: PROJECT_ID }),
    );
    expect(plan.commands).toContainEqual({
      type: "project.meta.update",
      commandId: expect.any(String),
      projectId: PROJECT_ID,
      title: "Renamed portable project",
      defaultModelSelection: sourceProject.defaultModelSelection,
      defaultThreadEnvMode: "worktree",
    });
    expect(plan.commands).not.toContainEqual(
      expect.objectContaining({ type: "project.meta.update", workspaceRoot: expect.anything() }),
    );
  });


  it("maps projects and threads to a different target project ID by repository identity", () => {
    const targetProjectId = ProjectId.make("project-target");
    const sourceProject = {
      ...makeSnapshot().projects[0]!,
      title: "Renamed portable project",
      updatedAt: LATER,
    };
    const archive = createPortabilityArchive(
      makeSnapshot({ projects: [sourceProject], updatedAt: LATER }),
      makeSettings(),
      LATER,
    );
    const target = makeSnapshot({
      projects: [
        {
          ...makeSnapshot().projects[0]!,
          id: targetProjectId,
          title: "Local project",
          workspaceRoot: "/Volumes/code/private-clone",
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

    expect(preview.changes).toContainEqual(
      expect.objectContaining({ recordType: "project", id: PROJECT_ID }),
    );
    expect(preview.additions).toContainEqual(
      expect.objectContaining({ recordType: "thread", id: THREAD_ID }),
    );
    expect(plan.commands).toContainEqual(
      expect.objectContaining({ type: "project.meta.update", projectId: targetProjectId }),
    );
    expect(plan.commands).toContainEqual(
      expect.objectContaining({ type: "thread.create", projectId: targetProjectId }),
    );
    expect(plan.commandItems).toContainEqual(
      expect.objectContaining({ recordType: "project", id: PROJECT_ID }),
    );
  });


  it("uses an unambiguous workspace name when repository identity is unavailable", () => {
    const targetProjectId = ProjectId.make("project-target");
    const source = makeSnapshot({
      projects: [{ ...makeSnapshot().projects[0]!, repositoryIdentity: null }],
    });
    const target = makeSnapshot({
      projects: [
        {
          ...makeSnapshot().projects[0]!,
          id: targetProjectId,
          workspaceRoot: "/Volumes/code/portable-project",
          repositoryIdentity: null,
        },
      ],
      threads: [],
    });
    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    const plan = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(plan.commands).toContainEqual(
      expect.objectContaining({ type: "thread.create", projectId: targetProjectId }),
    );
  });


  it("reports ambiguous project matches as conflicts", () => {
    const source = makeSnapshot();
    const baseProject = source.projects[0]!;
    const target = makeSnapshot({
      projects: [
        {
          ...baseProject,
          id: ProjectId.make("project-target-a"),
          workspaceRoot: "/Volumes/a/portable-project",
        },
        {
          ...baseProject,
          id: ProjectId.make("project-target-b"),
          workspaceRoot: "/Volumes/b/portable-project",
        },
      ],
      threads: [],
    });
    const archive = createPortabilityArchive(source, makeSettings(), NOW);
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

    expect(preview.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordType: "project", id: PROJECT_ID }),
        expect.objectContaining({ recordType: "thread", id: THREAD_ID }),
      ]),
    );
    expect(plan.commands.some((command) => command.type.startsWith("project."))).toBe(false);
    expect(plan.commands.some((command) => command.type.startsWith("thread."))).toBe(false);
  });


  it("rejects a stale preview token when projection state changes", () => {
    const snapshot = makeSnapshot();
    const settings = makeSettings();
    const archive = createPortabilityArchive(snapshot, settings, NOW);
    const preview = previewPortabilityImport(archive, snapshot, settings, AVAILABLE_PROVIDER_IDS);

    expect(isPortabilityPreviewCurrent(snapshot, settings, AVAILABLE_PROVIDER_IDS, preview)).toBe(
      true,
    );
    expect(
      isPortabilityPreviewCurrent(
        { ...snapshot, snapshotSequence: 8 },
        settings,
        AVAILABLE_PROVIDER_IDS,
        preview,
      ),
    ).toBe(false);
    expect(
      isPortabilityPreviewCurrent(
        snapshot,
        { ...settings, enableProviderUpdateChecks: !settings.enableProviderUpdateChecks },
        AVAILABLE_PROVIDER_IDS,
        preview,
      ),
    ).toBe(false);
    expect(isPortabilityPreviewCurrent(snapshot, settings, new Set(), preview)).toBe(false);
  });


  it("previews forced MCP disable as a change", () => {
    const snapshot = makeSnapshot();
    const settings = makeSettings();
    const preview = previewPortabilityImport(
      createPortabilityArchive(snapshot, settings, NOW),
      snapshot,
      settings,
      AVAILABLE_PROVIDER_IDS,
    );

    expect(preview.changes.map((entry) => entry.id)).toEqual([URL_MCP_ID, STDIO_MCP_ID]);
  });});
