import { AkeruMemoryCandidateId, BotId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { BotInboxItem } from "@t3tools/client-runtime/bot-inbox";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../i18n", async () => {
  const { createTranslator } = await import("@t3tools/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useI18n: () => ({ ...translator, t: translator.translate }) };
});
// The real row reads router and search state; the copy under test is what the row passes in.
vi.mock("./settingsLayout", () => ({
  SettingsRow: (props: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <h3>{props.title}</h3>
      <p data-slot="description">{props.description}</p>
      <div data-slot="status">{props.status}</div>
      {props.control}
    </div>
  ),
}));
vi.mock("../../pluginsDialogStore", () => ({ openPlugins: () => {} }));
vi.mock("../../settingsDialogStore", () => ({
  openSettings: () => {},
  useSettingsEnvironmentId: () => null,
}));
vi.mock("../../state/botInbox", () => ({ botInboxEnvironment: {} }));
vi.mock("../../state/memory", () => ({ memoryEnvironment: {} }));
vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: String,
  useEnvironmentQuery: () => ({}),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));

import { InboxIncidentRow } from "./InboxPanel";

const memoryItem: BotInboxItem = {
  id: "incident-1",
  incidentKey: "memory-approval:candidate-1",
  kind: "approval-request",
  status: "open",
  botId: BotId.make("bot-ada"),
  botName: "Ada",
  taskOrRoutine: "Refactor login",
  // The server's English fallback for older clients.
  lastFailure: "Save to project memory: Deploys happen on Fridays.",
  nextAction: "Approve or reject this memory.",
  firstSeenAt: "2026-09-20T10:00:00.000Z",
  lastSeenAt: "2026-09-20T10:00:00.000Z",
  occurrenceCount: 1,
  memoryApproval: {
    candidateId: AkeruMemoryCandidateId.make("candidate-1"),
    fact: "Deploys happen on Fridays.",
    scope: "project",
    sensitive: false,
    sourceThreadId: ThreadId.make("thread-ada"),
    authorBotId: BotId.make("bot-ada"),
    affectedBotIds: [BotId.make("bot-ada")],
  },
};

const render = (item: BotInboxItem) =>
  renderToStaticMarkup(
    <InboxIncidentRow
      item={item}
      environmentId={EnvironmentId.make("environment-1")}
      onResolve={null}
      onDecideMemory={async () => null}
    />,
  );

describe("InboxIncidentRow", () => {
  it("renders memory approvals from the structured request", () => {
    const markup = render(memoryItem);
    expect(markup).toContain("Ada · Refactor login · Memory approval");
    expect(markup).not.toContain("Approval needed");
    expect(markup).toContain('<p data-slot="description">Deploys happen on Fridays.</p>');
    expect(markup).toContain('<div data-slot="status">Save to project memory</div>');
    expect(markup.split("Deploys happen on Fridays.")).toHaveLength(2);
    expect(markup).not.toContain("Approve or reject this memory.");
    expect(markup).toContain(">Reject</button>");
    expect(markup).toContain(">Approve</button>");
  });

  it("keeps the server copy for other items", () => {
    const { memoryApproval: _memoryApproval, ...approval } = memoryItem;
    const markup = render({
      ...approval,
      incidentKey: "approval:req-1",
      lastFailure: "Codex wants to run a command.",
      nextAction: "Open the chat to answer.",
    });
    expect(markup).toContain("Ada · Refactor login · Approval needed");
    expect(markup).toContain("Codex wants to run a command.");
    expect(markup).toContain("Open the chat to answer.");
  });
});
