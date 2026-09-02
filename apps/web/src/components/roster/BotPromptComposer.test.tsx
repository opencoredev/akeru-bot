import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import {
  BotPromptAttachments,
  buildBotPromptAttachmentPreview,
  createBotPromptAttachments,
  releaseBotPromptAttachments,
  type BotPromptAttachment,
} from "./BotPromptAttachments";
import {
  appendBotMention,
  BotPromptComposer,
  canSubmitBotPrompt,
  findMentionedBotId,
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
    expect(appendBotMention("new draft", "Mori")).toBe("new draft @Mori ");
    expect(appendBotMention("", "Mori")).toBe("@Mori ");
  });

  it("expands for long or multiline prompts", () => {
    expect(isBotPromptExpanded("Short prompt")).toBe(false);
    expect(isBotPromptExpanded("Line one\nLine two")).toBe(true);
    expect(isBotPromptExpanded("x".repeat(81))).toBe(true);
  });

  it("routes the latest complete group mention to its bot", () => {
    expect(
      findMentionedBotId("Ask @Mori then @Path Finder ", [
        { id: "mori", name: "Mori" },
        { id: "pathfinder", name: "Path Finder" },
      ]),
    ).toBe("pathfinder");
    expect(findMentionedBotId("Email a@Mori.com", [{ id: "mori", name: "Mori" }])).toBeUndefined();
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
