// @effect-diagnostics nodeBuiltinImport:off - the parser tests need real symlinks and tmpdirs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
  parseCodexSkillsListResponse,
} from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

describe("parseCodexSkillsListResponse", () => {
  const makeSkill = (overrides: Record<string, unknown>) => ({
    name: "skill",
    path: "/repo/.agents/skills/skill/SKILL.md",
    description: "Skill description.",
    enabled: true,
    scope: "repo" as const,
    ...overrides,
  });

  const makeResponse = (entries: ReadonlyArray<{ cwd: string; skills: ReadonlyArray<unknown> }>) =>
    ({
      data: entries.map((entry) => ({
        cwd: entry.cwd,
        errors: [],
        skills: entry.skills,
      })),
    }) as Parameters<typeof parseCodexSkillsListResponse>[0];

  it.effect("returns an empty catalog when no entry's cwd matches the requested workspace", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-skills-"));
      const repoA = NodePath.join(tempDir, "repo-a");
      const repoB = NodePath.join(tempDir, "repo-b");
      const repoC = NodePath.join(tempDir, "repo-c");
      NodeFS.mkdirSync(repoA, { recursive: true });
      NodeFS.mkdirSync(repoB, { recursive: true });
      NodeFS.mkdirSync(repoC, { recursive: true });

      const response = makeResponse([
        { cwd: repoA, skills: [makeSkill({ name: "skill-a" })] },
        { cwd: repoB, skills: [makeSkill({ name: "skill-b" })] },
      ]);

      // The requested workspace is absent: no union of unrelated catalogs.
      assert.deepStrictEqual(yield* parseCodexSkillsListResponse(response, repoC), []);
      // Each real workspace still gets its own catalog.
      assert.deepStrictEqual(
        (yield* parseCodexSkillsListResponse(response, repoA)).map((skill) => skill.name),
        ["skill-a"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("matches entries through symlinked cwds", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-skills-link-"));
      const realRepo = NodePath.join(tempDir, "real-repo");
      NodeFS.mkdirSync(realRepo, { recursive: true });
      const linkRepo = NodePath.join(tempDir, "link-repo");
      NodeFS.symlinkSync(realRepo, linkRepo);

      const response = makeResponse([{ cwd: realRepo, skills: [makeSkill({ name: "linked" })] }]);

      assert.deepStrictEqual(
        (yield* parseCodexSkillsListResponse(response, linkRepo)).map((skill) => skill.name),
        ["linked"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("degrades gracefully when a reported or requested root is missing", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-skills-miss-"));
      const realRepo = NodePath.join(tempDir, "real-repo");
      NodeFS.mkdirSync(realRepo, { recursive: true });
      const missingRepo = NodePath.join(tempDir, "missing-repo");
      const goneRepo = NodePath.join(tempDir, "gone-repo");

      const response = makeResponse([
        { cwd: goneRepo, skills: [makeSkill({ name: "gone" })] },
        // A raw reported path equal to the missing cwd still matches.
        { cwd: missingRepo, skills: [makeSkill({ name: "raw-match" })] },
      ]);

      assert.deepStrictEqual(
        (yield* parseCodexSkillsListResponse(response, missingRepo)).map((skill) => skill.name),
        ["raw-match"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("maps the small icon, falls back to the large icon, and omits absent icons", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-skills-icons-"));
      const response = makeResponse([
        {
          cwd: tempDir,
          skills: [
            makeSkill({
              name: "small-icon",
              interface: {
                displayName: "Small Icon",
                iconSmall: "/icons/small.png",
                iconLarge: "/icons/large.png",
              },
            }),
            makeSkill({
              name: "large-only",
              interface: { iconLarge: "/icons/large-only.png" },
            }),
            makeSkill({ name: "no-icon" }),
          ],
        },
      ]);

      const skills = yield* parseCodexSkillsListResponse(response, tempDir);
      assert.equal(skills.find((skill) => skill.name === "small-icon")?.icon, "/icons/small.png");
      assert.equal(
        skills.find((skill) => skill.name === "large-only")?.icon,
        "/icons/large-only.png",
      );
      assert.equal(skills.find((skill) => skill.name === "no-icon")?.icon, undefined);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
