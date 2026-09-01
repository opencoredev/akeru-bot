// @effect-diagnostics nodeBuiltinImport:off - This integration guard reads its sibling source.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("BotThreadLanding message formatting", () => {
  it("renders assistant messages with the shared rich markdown component", () => {
    const entries = [
      ["BotThreadLanding.tsx", "bot-provider-message", "bot-user-message"],
      ["GroupThreadLanding.tsx", "group-provider-message", "group-user-message"],
    ] as const;

    for (const [file, assistantTestId, userTestId] of entries) {
      const source = NodeFS.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const assistantStart = source.indexOf(`data-testid="${assistantTestId}"`);
      const userStart = source.indexOf(`data-testid="${userTestId}"`, assistantStart);
      const assistantSource = source.slice(assistantStart, userStart);

      expect(assistantStart).toBeGreaterThan(-1);
      expect(userStart).toBeGreaterThan(assistantStart);
      expect(assistantSource).toContain("<ChatMarkdown");
      expect(assistantSource).toContain("cwd={runtime.defaultProject?.workspaceRoot}");
      expect(assistantSource).toContain("threadRef={runtime.linkedThreadRef ?? undefined}");
      expect(assistantSource).toContain('className="min-w-0 flex-1"');
      expect(assistantSource).not.toContain("onTaskListChange");
      expect(source.slice(userStart)).toContain('className="whitespace-pre-wrap"');
    }
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
