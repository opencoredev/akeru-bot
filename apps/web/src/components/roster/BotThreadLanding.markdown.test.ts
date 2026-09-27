// @effect-diagnostics nodeBuiltinImport:off - This integration guard reads its sibling source.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

function readSibling(file: string) {
  return NodeFS.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
}

/** Returns the source of one exported memo row component. */
function rowComponent(source: string, name: string) {
  const start = source.indexOf(`export const ${name} = memo(`);
  const end = source.indexOf("\nexport ", start + 1);
  return start < 0 ? "" : source.slice(start, end < 0 ? source.length : end);
}

describe("BotThreadLanding message formatting", () => {
  it("renders assistant messages with the shared rich markdown component", () => {
    const entries = [
      ["BotThreadLanding.tsx", "bot-provider-message", "bot-user-message"],
      ["GroupThreadLanding.tsx", "group-provider-message", "group-user-message"],
    ] as const;

    for (const [file, assistantTestId, userTestId] of entries) {
      const source = readSibling(file);
      const assistantStart = source.indexOf(`testId="${assistantTestId}"`);
      const userStart = source.indexOf(`testId="${userTestId}"`, assistantStart);
      const assistantSource = source.slice(assistantStart, userStart);

      expect(assistantStart).toBeGreaterThan(-1);
      expect(userStart).toBeGreaterThan(assistantStart);
      expect(source.lastIndexOf("<AssistantMessageRow", assistantStart)).toBeGreaterThan(-1);
      expect(assistantSource).toContain("cwd={runtime.defaultProject?.workspaceRoot}");
      expect(assistantSource).toContain("threadRef={runtime.linkedThreadRef ?? undefined}");
      expect(source.lastIndexOf("<UserMessageRow", userStart)).toBeGreaterThan(assistantStart);
    }

    const assistantRow = rowComponent(readSibling("BotChatMessageRows.tsx"), "AssistantMessageRow");
    expect(assistantRow).toContain("<ChatMarkdown");
    expect(assistantRow).toContain('className="min-w-0 flex-1"');
    expect(assistantRow).not.toContain("onTaskListChange");
    const userRow = rowComponent(readSibling("BotChatMessageRows.tsx"), "UserMessageRow");
    expect(userRow).toContain('className="whitespace-pre-wrap"');
  });

  it("renders step meters for bot and group replies", () => {
    for (const file of ["BotThreadLanding.tsx", "GroupThreadLanding.tsx"]) {
      expect(readSibling(file)).toContain("stepMeters.get(message.turnId)");
    }
    const assistantRow = rowComponent(readSibling("BotChatMessageRows.tsx"), "AssistantMessageRow");
    expect(assistantRow).toContain("<BotStepMeter meter={stepMeter} />");
  });

  it("uses the free-scrolling conversation area instead of end-justified overflow", () => {
    const botSource = NodeFS.readFileSync(
      new URL("./BotThreadLanding.tsx", import.meta.url),
      "utf8",
    );
    const groupSource = NodeFS.readFileSync(
      new URL("./GroupThreadLanding.tsx", import.meta.url),
      "utf8",
    );

    expect(botSource).toContain("<BotConversationScrollArea>");
    expect(groupSource).toContain("<BotConversationScrollArea>");
    expect(botSource).not.toContain("justify-end gap-4");
    expect(groupSource).not.toContain("justify-end gap-4");
  });

  it("renders the shared approval card in bot and group threads", () => {
    const sources = ["BotThreadLanding.tsx", "GroupThreadLanding.tsx"].map((file) =>
      NodeFS.readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
    );

    for (const source of sources) {
      expect(source).toContain("<BotApprovalPrompt");
      expect(source).toContain("useRosterPendingApproval(runtime.linkedThreadRef)");
      expect(source).toContain("pendingApproval !== null ||");
    }
  });

  it("keeps message actions visible for coarse pointers without dropping reply controls", () => {
    const source = readSibling("BotChatMessageRows.tsx");
    expect(source).toContain("pointer-coarse:opacity-100");

    for (const name of ["AssistantMessageRow", "UserMessageRow"]) {
      const row = rowComponent(source, name);
      const controls = row.split("<MessageControls").slice(1);
      expect(controls.length).toBeGreaterThan(0);
      expect(row).toContain("HOVER_CONTROLS_CLASS");
      for (const block of controls) {
        const props = block.slice(0, block.indexOf("/>"));
        expect(props).toContain("onReply=");
        if (name === "AssistantMessageRow") expect(props).toContain("readAloud");
      }
    }
    // Only the "Unavailable bot" layout omits reactions.
    const assistantControls = rowComponent(source, "AssistantMessageRow").split("<MessageControls");
    expect(assistantControls[2]).toContain("onReactionChange=");
    expect(rowComponent(source, "UserMessageRow")).toContain("onReactionChange=");
  });

  it("mounts the voice action in the live bot chat header", () => {
    const source = NodeFS.readFileSync(new URL("./BotThreadLanding.tsx", import.meta.url), "utf8");

    expect(source).toContain(
      'import { BotVoiceCallButton, useVoiceCall } from "../voice/VoiceCall"',
    );
    expect(source).toContain("data-chat-header-actions");
    expect(source).toContain('runtime.latestTurn?.state === "running"');
    expect(source).toContain("voiceCall.activeCall?.botId === bot.id");
    expect(source).toContain("voiceCall.startingBotId === bot.id");
  });
});
