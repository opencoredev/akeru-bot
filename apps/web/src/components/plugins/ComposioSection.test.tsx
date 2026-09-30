import type { ComposioConnection, ComposioToolkit } from "@akeru/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { loadDirectoryCatalog } from "../../../../../plugins";
import {
  ComposioAccounts,
  activeComposioToolkitIds,
  composioConnectionLabel,
  composioSearchResults,
} from "./ComposioSection";
import { ComposioToolkitResults } from "./PluginsCatalog";

const catalog = loadDirectoryCatalog();

function toolkit(slug: string, name: string): ComposioToolkit {
  return { slug, name, categories: [], toolsCount: 3 };
}

const connections: readonly ComposioConnection[] = [
  { id: "ca_1", toolkitSlug: "slack", status: "ACTIVE", alias: "Work Slack" },
  { id: "ca_2", toolkitSlug: "notion", status: "INITIATED" },
  { id: "ca_3", toolkitSlug: "github", status: "EXPIRED" },
];

describe("composioSearchResults", () => {
  it("drops toolkits the directory brokers, so Gmail keeps its pending blocker", () => {
    const gmail = catalog.find((plugin) => plugin.id === "gmail");
    expect(gmail?.connection.type).toBe("brokered");
    const results = composioSearchResults(
      [toolkit("gmail", "Gmail"), toolkit("slack", "Slack")],
      catalog,
    );
    expect(results.map((result) => result.slug)).toEqual(["slack"]);
  });

  it("keeps only connected toolkits for the Installed filter", () => {
    const results = composioSearchResults(
      [toolkit("slack", "Slack"), toolkit("notion", "Notion")],
      catalog,
      activeComposioToolkitIds(connections),
    );
    expect(results.map((result) => result.slug)).toEqual(["slack"]);
  });
});

describe("activeComposioToolkitIds", () => {
  it("counts only active accounts as connected", () => {
    expect([...activeComposioToolkitIds(connections)]).toEqual(["slack"]);
  });
});

describe("composioConnectionLabel", () => {
  it("names each account state in plain words", () => {
    expect(composioConnectionLabel("ACTIVE")).toBe("Connected");
    expect(composioConnectionLabel("INITIATED")).toBe("Waiting for sign-in");
    expect(composioConnectionLabel("FAILED")).toBe("Sign-in failed");
    expect(composioConnectionLabel("REVOKED")).toBe("Revoked");
  });
});

describe("ComposioAccounts", () => {
  it("says when a configured key has no accounts yet", () => {
    const html = renderToStaticMarkup(
      <ComposioAccounts connections={[]} pendingId={null} onDisconnect={() => {}} />,
    );
    expect(html).toContain("No accounts connected yet");
  });

  it("lists every account with its state and a disconnect action", () => {
    const html = renderToStaticMarkup(
      <ComposioAccounts connections={connections} pendingId={null} onDisconnect={() => {}} />,
    );
    expect(html).toContain("Work Slack");
    expect(html).toContain("Waiting for sign-in");
    expect(html).toContain("Expired");
    expect(html).toContain('aria-label="Disconnect Work Slack"');
    expect(html).toContain('aria-label="Disconnect notion"');
  });

  it("disables disconnect while another Composio command runs", () => {
    const html = renderToStaticMarkup(
      <ComposioAccounts connections={connections} pendingId="key" onDisconnect={() => {}} />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(connections.length);
  });
});

describe("ComposioToolkitResults", () => {
  it("offers Connect for new apps and marks connected ones", () => {
    const html = renderToStaticMarkup(
      <ComposioToolkitResults
        toolkits={[toolkit("slack", "Slack"), toolkit("linear", "Linear")]}
        connectedToolkitIds={new Set(["slack"])}
        pendingToolkitId={null}
        onConnect={() => {}}
      />,
    );
    expect(html).toContain("From Composio");
    expect(html).toContain('aria-label="Connected Slack"');
    expect(html).toContain('aria-label="Connect Linear"');
  });
});
