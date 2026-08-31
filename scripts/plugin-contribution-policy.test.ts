// @effect-diagnostics nodeBuiltinImport:off - Tests inspect repository policy files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

type PathLabelConfig = Record<
  string,
  Array<{
    "changed-files": Array<{ "any-glob-to-any-file": string | string[] }>;
  }>
>;

function text(path: string): string {
  return NodeFS.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function yaml(path: string): Record<string, unknown> {
  return parse(text(path)) as Record<string, unknown>;
}

function labelsForPath(config: PathLabelConfig, path: string): string[] {
  return Object.entries(config).flatMap(([label, rules]) =>
    rules.some((rule) =>
      rule["changed-files"].some((condition) => {
        const patterns = condition["any-glob-to-any-file"];
        return (typeof patterns === "string" ? [patterns] : patterns).some((pattern) =>
          NodePath.matchesGlob(path, pattern),
        );
      }),
    )
      ? [label]
      : [],
  );
}

describe("plugin contribution policy", () => {
  it.each([
    ["plugin_proposal.yml", "type:plugin", ["product", "mcp_ownership", "logo", "permissions"]],
    ["provider_proposal.yml", "type:provider", ["provider", "runtime", "logo", "approvals"]],
  ])("collects admission evidence in %s", (file, typeLabel, specificFields) => {
    const form = yaml(`.github/ISSUE_TEMPLATE/${file}`) as {
      labels: string[];
      body: Array<{
        id?: string;
        attributes?: { options?: Array<{ required?: boolean }> };
        validations?: { required?: boolean };
      }>;
    };
    const required = form.body
      .filter((field) => field.validations?.required)
      .map((field) => field.id);

    expect(form.labels).toEqual([typeLabel, "status:needs-triage"]);
    expect(required).toEqual(
      expect.arrayContaining([
        "demand",
        "akeru_job",
        "lifecycle",
        "documentation",
        "health",
        "blocker",
        ...specificFields,
      ]),
    );
    expect(
      form.body.find((field) => field.id === "credential_safety")?.attributes?.options,
    ).toEqual([expect.objectContaining({ required: true })]);
  });

  it.each([
    ["plugins/entries/exa/plugin.json", ["type:plugin"]],
    ["apps/server/src/provider/builtInDrivers.ts", ["type:provider"]],
    ["apps/server/src/provider/builtInProviderCatalog.ts", ["type:provider"]],
    ["apps/server/src/provider/Drivers/ClaudeDriver.ts", ["type:provider"]],
    ["apps/server/src/provider/Layers/CodexAdapter.ts", ["type:provider"]],
    ["apps/server/src/provider/Services/ClaudeAdapter.ts", ["type:provider"]],
    ["apps/server/src/subscription-auth/providers/openaiCodex.ts", ["type:provider"]],
    ["apps/web/src/components/plugins/PluginsDialog.tsx", ["area:directory"]],
    ["apps/web/src/components/settings/PluginsSettings.tsx", ["area:directory"]],
    ["apps/web/src/pluginsDialogStore.ts", ["area:directory"]],
    ["docs/user/plugins.md", ["area:directory"]],
    ["apps/web/src/components/sidebar/SidebarChrome.tsx", ["area:directory"]],
    ["apps/web/src/components/roster/BotToolsSheet.tsx", ["area:directory"]],
    ["apps/server/src/provider/McpServerConfig.ts", ["area:connectors"]],
    ["apps/server/src/provider/Layers/AgentController.ts", ["type:provider", "area:connectors"]],
    ["apps/server/src/persistence/Layers/ProjectionMcpServers.ts", ["area:connectors"]],
    ["apps/server/src/persistence/Services/ProjectionMcpServers.ts", ["area:connectors"]],
    ["apps/server/src/orchestration/Layers/McpServerRegistry.test.ts", ["area:connectors"]],
    ["apps/server/src/bot-inbox/connectorIncidents.ts", ["area:connectors"]],
    ["apps/server/src/bot-inbox/connectorIncidents.test.ts", ["area:connectors"]],
    ["packages/contracts/src/mcpServer.ts", ["area:connectors"]],
    ["packages/client-runtime/src/state/mcpServerCommands.ts", ["area:connectors"]],
    ["apps/web/src/state/mcpServers.ts", ["area:connectors"]],
    ["apps/server/src/mcp/McpHttpServer.ts", []],
    ["apps/mobile/plugins/withAndroidCleartextTraffic.cjs", []],
  ])("maps %s to its contribution labels", (path, expected) => {
    const config = yaml(".github/path-labels.yml") as PathLabelConfig;

    expect(NodeFS.existsSync(new URL(`../${path}`, import.meta.url))).toBe(true);
    expect(labelsForPath(config, path)).toEqual(expected);
  });

  it("uses one path-label job and mints no auth or category labels", () => {
    const pathLabels = yaml(".github/path-labels.yml") as PathLabelConfig;
    const issueLabelWorkflow = yaml(".github/workflows/issue-labels.yml") as {
      jobs: Record<string, unknown>;
    };
    const issueLabels = text(".github/workflows/issue-labels.yml");
    const mintedLabels = [...issueLabels.matchAll(/name: "([^"]+)"/g)].map((match) => match[1]);

    expect(
      NodeFS.existsSync(new URL("../.github/workflows/contribution-labels.yml", import.meta.url)),
    ).toBe(false);
    expect(Object.keys(issueLabelWorkflow.jobs)).toEqual(["sync", "label-paths"]);
    expect(issueLabels).toContain("uses: actions/labeler@v6");
    expect(issueLabels).toContain("configuration-path: .github/path-labels.yml");
    expect(mintedLabels).toEqual(
      expect.arrayContaining([
        "type:plugin",
        "type:provider",
        "status:needs-triage",
        "area:directory",
        "area:connectors",
      ]),
    );
    expect([...Object.keys(pathLabels), ...mintedLabels]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(?:auth|category):/)]),
    );
    expect(labelsForPath(pathLabels, "apps/server/src/mcp/McpHttpServer.ts")).toEqual([]);
  });

  it("documents the admission and safety rules", () => {
    const contributorRules = text("plugins/AGENTS.md");
    const publicRules = text("plugins/README.md");

    for (const requirement of [
      "curated directory",
      "not a complete MCP registry",
      "does not guarantee acceptance",
      "Custom MCP",
      "experimental apps, wrappers, duplicates, and narrow utilities",
      "PostgreSQL, SQLite, Redis, Docker, Playwright, time, fetch, filesystem, and generic memory",
      "actively use the product",
      "user or maintainer requested",
      "real Akeru Bot job",
      "official or trusted MCP server",
      "current setup and reference documentation",
      "approval-pending",
      "accountable publisher",
      "logo",
      "add, connect, use, disable, re-enable, and remove",
      "export a provider token or secret",
      "send, pay, delete, production, secrets, publishing, signatures, refunds, and account-wide",
    ]) {
      expect(contributorRules).toContain(requirement);
    }

    expect(publicRules).toContain("This is a curated directory, not a complete MCP registry");
    expect(publicRules).toContain("experimental apps, wrappers, duplicates, and narrow utilities");
    expect(text(".github/ISSUE_TEMPLATE/plugin_proposal.yml")).toContain(
      "experimental apps, wrappers, duplicates, and narrow utilities",
    );
  });

  it("runs the existing catalog validator in CI", () => {
    const ci = yaml(".depot/workflows/ci.yml") as {
      jobs: Record<string, { steps?: Array<{ run?: string }> }>;
    };
    const commands = Object.values(ci.jobs).flatMap(
      (job) => job.steps?.map((step) => step.run) ?? [],
    );

    expect(commands).toContain("bun run plugins:check");
  });

  it("keeps issue routing and the accepted-proposal PR exception coherent", () => {
    const issueConfig = yaml(".github/ISSUE_TEMPLATE/config.yml") as {
      contact_links: Array<{ name: string; url: string }>;
    };
    const contributionGuide = text("CONTRIBUTING.md");
    const pullRequestTemplate = text(".github/pull_request_template.md");

    expect(issueConfig.contact_links.find((link) => link.name === "Feature request")?.url).toBe(
      "https://github.com/pingdotgg/t3code/discussions/categories/ideas",
    );
    expect(contributionGuide).not.toContain("opencoredev/akeru-bot/discussions");
    expect(contributionGuide).toContain("plugin and provider proposal forms");
    expect(pullRequestTemplate).toContain("accepted plugin or provider proposal");
  });
});
