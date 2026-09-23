import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";

vi.mock("../../i18n", async () => {
  const { createTranslator } = await import("@t3tools/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useI18n: () => ({ ...translator, t: translator.translate }) };
});
import {
  BotPromptAttachments,
  buildBotPromptAttachmentPreview,
  createBotPromptAttachments,
  releaseBotPromptAttachments,
  type BotPromptAttachment,
} from "./BotPromptAttachments";
import {
  applyBotPromptMention,
  botPromptMention,
  botPromptMentionTrigger,
  buildBotPromptMentionItems,
} from "./botPromptMentions.logic";
import {
  appendBotMention,
  BotPromptComposer,
  botPromptCommandMenuTrigger,
  canSubmitBotPrompt,
  botMentionHint,
  resolveBotMention,
  isBotPromptSubmissionCurrent,
  isBotPromptExpanded,
  restoreBotStashPrompt,
  shouldFocusBotPromptForKey,
} from "./BotPromptComposer";

afterEach(() => {
  vi.restoreAllMocks();
});

function imageFile(name: string): File {
  return new File([name], name, { type: "image/png" });
}

describe("bot prompt composer", () => {
  it("does not submit while disabled", () => {
    expect(canSubmitBotPrompt(true, "Send this", 0)).toBe(false);
    expect(canSubmitBotPrompt(false, "Send this", 0)).toBe(true);
    expect(canSubmitBotPrompt(false, "", 1)).toBe(true);
  });

  it("restores a failed submission only while the composer remains unchanged", () => {
    expect(isBotPromptSubmissionCurrent(3, 3)).toBe(true);
    expect(isBotPromptSubmissionCurrent(3, 4)).toBe(false);
  });

  it("preserves new draft text when inserting a mention", () => {
    expect(appendBotMention("new draft", "@Mori")).toBe("new draft @Mori ");
    expect(appendBotMention("", "@bot:mori-2")).toBe("@bot:mori-2 ");
  });

  it("opens the $ and / pickers when no provider catalog is connected", () => {
    const open = (draft: string, commandCatalog: null | undefined, readOnly = false) =>
      botPromptCommandMenuTrigger({ draft, caret: draft.length, readOnly, commandCatalog })?.kind;
    expect(open("$", null)).toBe("skill");
    expect(open("hi $", null)).toBe("skill");
    expect(open("/", null)).toBe("slash-command");
    // Onboarding previews omit the catalog and read-only chats never type.
    expect(open("$", undefined)).toBeUndefined();
    expect(open("/", null, true)).toBeUndefined();
  });

  it("expands for long or multiline prompts", () => {
    expect(isBotPromptExpanded("Short prompt")).toBe(false);
    expect(isBotPromptExpanded("Line one\nLine two")).toBe(true);
    expect(isBotPromptExpanded("x".repeat(81))).toBe(true);
  });

  it("routes the latest complete group mention to its bot", () => {
    expect(
      resolveBotMention("Ask @Mori then @Path Finder ", [
        { id: "mori", name: "Mori" },
        { id: "pathfinder", name: "Path Finder" },
      ]),
    ).toEqual({ kind: "bot", botId: "pathfinder" });
    expect(resolveBotMention("Email a@Mori.com", [{ id: "mori", name: "Mori" }])).toEqual({
      kind: "none",
    });
  });

  it("prefers the longer bot name when two names start at the same mention", () => {
    expect(
      resolveBotMention("@Path Finder look", [
        { id: "path", name: "Path" },
        { id: "pathfinder", name: "Path Finder" },
      ]),
    ).toEqual({ kind: "bot", botId: "pathfinder" });
  });

  it("keeps a person mention as plain text so the boss answers", () => {
    const groupBots = [
      { id: "boss", name: "Akeru" },
      { id: "mori", name: "Mori" },
    ];
    expect(resolveBotMention("Thanks @Leo, can you check this?", groupBots)).toEqual({
      kind: "none",
    });
    expect(resolveBotMention("@Leo asked for this. @Mori please review", groupBots)).toEqual({
      kind: "bot",
      botId: "mori",
    });
  });

  it("refuses to route a name two group bots share, whatever their order", () => {
    const mori = { id: "mori-claude", name: "Mori" };
    const otherMori = { id: "mori-grok", name: "Mori" };
    const akeru = { id: "boss", name: "Akeru" };
    for (const bots of [
      [akeru, mori, otherMori],
      [otherMori, akeru, mori],
    ]) {
      const mention = resolveBotMention("@Mori check the logs", bots);
      expect(mention).toEqual({ kind: "ambiguous", name: "Mori" });
      expect(botMentionHint(mention)).toBe(
        "More than one bot here is named Mori. Pick one from the @ menu to mention it.",
      );
      expect(resolveBotMention("@Mori then @Akeru", bots)).toEqual({ kind: "bot", botId: "boss" });
    }
    expect(botMentionHint({ kind: "bot", botId: "boss" })).toBeNull();
  });

  it("submits to the exact Mika picked from either menu", () => {
    const mikas = [
      { id: "mika-claude", name: "Mika", title: "Designer" },
      { id: "mika-grok", name: "Mika", title: "Reviewer" },
    ];
    const trigger = botPromptMentionTrigger("@mika", 5)!;
    const rows = buildBotPromptMentionItems({
      query: trigger.query,
      browserAvailable: false,
      bots: mikas,
      threads: [],
    });
    expect(rows).toHaveLength(2);
    for (const [index, bot] of mikas.entries()) {
      const picked = applyBotPromptMention("@mika", trigger, rows[index]!).text;
      const draft = `${picked}please review`;
      expect(resolveBotMention(draft, mikas)).toEqual({ kind: "bot", botId: bot.id });
      expect(botMentionHint(resolveBotMention(draft, mikas))).toBeNull();

      const appended = appendBotMention("please review", botPromptMention(bot, mikas).source);
      expect(resolveBotMention(appended, mikas)).toEqual({ kind: "bot", botId: bot.id });
    }
  });

  it("focuses the prompt for unmodified printable typing outside an editor", () => {
    const baseInput = {
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      editableTarget: false,
      isComposing: false,
      key: "a",
      metaKey: false,
    };

    expect(shouldFocusBotPromptForKey(baseInput)).toBe(true);
    expect(shouldFocusBotPromptForKey({ ...baseInput, key: "Enter" })).toBe(false);
    expect(shouldFocusBotPromptForKey({ ...baseInput, metaKey: true })).toBe(false);
    expect(shouldFocusBotPromptForKey({ ...baseInput, editableTarget: true })).toBe(false);
    expect(shouldFocusBotPromptForKey({ ...baseInput, isComposing: true })).toBe(false);
  });

  it("restores stashed text after the current draft", () => {
    expect(restoreBotStashPrompt("Current draft  ", "Stashed follow-up")).toBe(
      "Current draft\n\nStashed follow-up",
    );
    expect(restoreBotStashPrompt("", "Stashed follow-up")).toBe("Stashed follow-up");
    expect(restoreBotStashPrompt("   ", "Stashed follow-up")).toBe("Stashed follow-up");
    expect(restoreBotStashPrompt("Current draft", "")).toBe("Current draft");
  });

  it("uses the available chat width", () => {
    const markup = renderToStaticMarkup(
      <BotPromptComposer botName="Akeru" disabled={false} onSubmit={vi.fn(async () => true)} />,
    );

    expect(markup).toContain('class="w-full px-4');
    expect(markup).not.toContain("max-w-4xl");
  });

  it("attaches a pending question above the custom answer field", () => {
    const markup = renderToStaticMarkup(
      <BotPromptComposer
        botName="Akeru"
        disabled={false}
        pendingActionSlot={<div data-testid="pending-question">Question</div>}
        placeholder="Write a custom answer…"
        onSubmit={vi.fn(async () => true)}
      />,
    );

    expect(markup).toContain('data-testid="pending-question"');
    expect(markup).toContain('data-testid="bot-pending-action-motion"');
    expect(markup).toContain('placeholder="Write a custom answer…"');
    expect(markup).toContain("rounded-t-md border-t-transparent");
  });

  it("squares the prompt box against an approval rendered above it", () => {
    const withoutApproval = renderToStaticMarkup(
      <BotPromptComposer botName="Akeru" disabled={false} onSubmit={vi.fn(async () => true)} />,
    );
    const withApproval = renderToStaticMarkup(
      <BotPromptComposer
        botName="Akeru"
        disabled={false}
        pendingActionSlot={<div data-testid="approval-slot">Run this command?</div>}
        onSubmit={vi.fn(async () => true)}
      />,
    );

    expect(withoutApproval).not.toContain("rounded-t-md");
    expect(withApproval).toContain('data-testid="approval-slot"');
    expect(withApproval).toContain("rounded-t-md");
    expect(withApproval).toContain("border-t-transparent");
  });

  it("puts dictation in the send slot when the draft is empty", () => {
    const markup = renderToStaticMarkup(
      <BotPromptComposer botName="Mori" disabled={false} onSubmit={async () => true} />,
    );
    expect(markup).toContain("data-bot-prompt-dictation");
    expect(markup).toContain('aria-label="Start dictation"');
    expect(markup).toContain("lucide-mic");
    expect(markup).not.toContain('aria-label="Send message"');
  });

  it("keeps send in the slot for an inert preview", () => {
    const markup = renderToStaticMarkup(
      <BotPromptComposer botName="Mori" disabled readOnly onSubmit={async () => true} />,
    );
    expect(markup).not.toContain("data-bot-prompt-dictation");
    expect(markup).toContain('aria-label="Send message"');
  });

  it("renders an inert preview with the production composer", () => {
    const markup = renderToStaticMarkup(
      <BotPromptComposer
        botName="Your bot"
        disabled
        readOnly
        onSubmit={vi.fn(async () => false)}
      />,
    );

    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('readOnly=""');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).toContain('aria-label="Attach files"');
  });

  it("does not render model or reasoning controls", () => {
    const markup = renderToStaticMarkup(
      <BotPromptComposer botName="Akeru" disabled={false} onSubmit={vi.fn(async () => true)} />,
    );

    expect(markup).not.toContain("Reasoning");
    expect(markup).not.toContain('aria-label="Change model"');
    expect(markup).not.toContain("data-chat-provider-model-picker");
  });

  it("creates stable previews in file order and releases their object URLs", () => {
    const first = imageFile("same-name.png");
    const second = imageFile("same-name.png");
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const attachments = createBotPromptAttachments([first, second]);

    expect(attachments.map((attachment) => attachment.file)).toEqual([first, second]);
    expect(attachments[0]?.id).not.toBe(attachments[1]?.id);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(buildBotPromptAttachmentPreview(attachments, attachments[1]!.id)).toEqual({
      images: [
        { src: "blob:first", name: "same-name.png" },
        { src: "blob:second", name: "same-name.png" },
      ],
      index: 1,
    });
    expect(
      buildBotPromptAttachmentPreview(
        attachments,
        attachments[1]!.id,
        new Set([attachments[0]!.id]),
      ),
    ).toEqual({
      images: [{ src: "blob:second", name: "same-name.png" }],
      index: 0,
    });

    releaseBotPromptAttachments(attachments);
    expect(revokeObjectURL.mock.calls).toEqual([["blob:first"], ["blob:second"]]);
  });

  it("renders a live thumbnail with independent preview and remove controls", () => {
    const onExpand = vi.fn();
    const onPreviewError = vi.fn();
    const onRemove = vi.fn();
    const attachment: BotPromptAttachment = {
      id: "attachment-1",
      file: imageFile("preview.png"),
      previewUrl: "blob:preview",
    };
    const tree = BotPromptAttachments({
      attachments: [attachment],
      onExpand,
      onPreviewError,
      onRemove,
    });
    const markup = renderToStaticMarkup(tree);
    const preview = visitElements(
      tree,
      (element) => element.props["aria-label"] === "Preview preview.png",
    );
    const remove = visitElements(
      tree,
      (element) => element.props["aria-label"] === "Remove preview.png",
    );
    const image = visitElements(tree, (element) => element.props.alt === "preview.png");

    expect(markup).toContain('src="blob:preview"');
    expect(markup).toContain('alt="preview.png"');
    expect(markup).not.toContain("PaperclipIcon");

    (preview?.props.onClick as (() => void) | undefined)?.();
    expect(onExpand).toHaveBeenCalledOnce();
    expect(onExpand).toHaveBeenCalledWith("attachment-1");
    expect(onRemove).not.toHaveBeenCalled();

    (remove?.props.onClick as (() => void) | undefined)?.();
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith("attachment-1");
    expect(onExpand).toHaveBeenCalledOnce();

    const removeAttribute = vi.fn();
    const setAttribute = vi.fn();
    const currentTarget = {
      hidden: false,
      nextElementSibling: { removeAttribute },
      closest: () => ({ setAttribute }),
    };
    (
      image?.props.onError as ((event: { currentTarget: typeof currentTarget }) => void) | undefined
    )?.({ currentTarget });
    expect(currentTarget.hidden).toBe(true);
    expect(onPreviewError).toHaveBeenCalledWith("attachment-1");
    expect(removeAttribute).toHaveBeenCalledWith("hidden");
    expect(setAttribute).toHaveBeenCalledWith("disabled", "");
  });
});
