import { presentThreadError } from "@t3tools/client-runtime/errors";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BotTurnFailureRow } from "./BotTurnFailureRow";
import { latestBotThreadFailure } from "./threadRuntimeWarning.logic";

const sentAt = "2026-09-23T05:00:00.000Z";
const startFailed: OrchestrationThreadActivity = {
  id: EventId.make("activity-start-failed"),
  tone: "error",
  kind: "provider.turn.start.failed",
  summary: "Provider turn start failed",
  payload: { detail: "Claude Code is not authenticated.", unavailability: "missing-login" },
  turnId: null,
  createdAt: sentAt,
};

describe("BotThreadLanding failed request", () => {
  it("fills the reply slot of a request the provider never started", () => {
    const failure = latestBotThreadFailure({
      activities: [startFailed],
      latestTurn: null,
      session: { status: "error", lastError: "Claude Code is not authenticated." },
      lastUserMessageAt: sentAt,
    });
    expect(failure).not.toBeNull();

    const title = presentThreadError(failure!.message, {
      unavailability: failure!.unavailability,
      providerName: "Claude",
    }).title;
    const html = renderToStaticMarkup(<BotTurnFailureRow botName="Mika" title={title} />);

    expect(html).toContain('data-testid="bot-turn-failure"');
    expect(html).toContain("Mika did not reply. Claude is not connected.");
    expect(html).not.toContain("thread");
    expect(html).not.toContain("—");
  });
});
