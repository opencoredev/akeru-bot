import type { ServerProviderSkill } from "@t3tools/contracts";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  createEditor,
  type SerializedEditorState,
} from "lexical";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import {
  $createComposerSkillNode,
  ComposerSkillNode,
  skillMetadataByName,
} from "./composerSkillNode";

const iconSkill: ServerProviderSkill = {
  name: "review-follow-up",
  displayName: "Review Follow-up",
  path: "/skills/review-follow-up/SKILL.md",
  enabled: true,
  icon: "🔧",
};

const assetIconSkill: ServerProviderSkill = {
  name: "deploy",
  path: "/skills/deploy/SKILL.md",
  enabled: true,
  icon: "/icons/deploy.png",
};

function createSkillEditor() {
  return createEditor({
    nodes: [ComposerSkillNode],
    onError: (error) => {
      throw error;
    },
  });
}

// Loads a prompt the way the composer does: `$name` segments become chips.
function loadPrompt(prompt: string, skills: ReadonlyArray<ServerProviderSkill>) {
  const editor = createSkillEditor();
  const metadata = skillMetadataByName(skills);
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      for (const segment of splitPromptIntoComposerSegments(prompt)) {
        if (segment.type === "skill") {
          paragraph.append($createComposerSkillNode(segment.name, metadata.get(segment.name)));
        } else if (segment.type === "text") {
          paragraph.append($createTextNode(segment.text));
        }
      }
      $getRoot().clear().append(paragraph);
    },
    { discrete: true },
  );
  return editor;
}

function readChips(editor: ReturnType<typeof createSkillEditor>) {
  return editor.getEditorState().read(() => {
    const paragraph = $getRoot().getFirstChild();
    const chips = $isElementNode(paragraph)
      ? paragraph.getChildren().filter((node) => node instanceof ComposerSkillNode)
      : [];
    return {
      markup: chips.map((chip) => renderToStaticMarkup(chip.decorate())),
      text: $getRoot().getTextContent(),
    };
  });
}

function serializedChips(state: SerializedEditorState) {
  return state.root.children.flatMap((paragraph) =>
    "children" in paragraph && Array.isArray(paragraph.children)
      ? paragraph.children.filter((node) => node.type === "composer-skill")
      : [],
  );
}

describe("composer skill chip", () => {
  it("turns $name into a chip and submits $name back", () => {
    const prompt = "Run $review-follow-up then $deploy now";
    const editor = loadPrompt(prompt, [iconSkill, assetIconSkill]);

    expect(serializedChips(editor.getEditorState().toJSON())).toMatchObject([
      { skillName: "review-follow-up" },
      { skillName: "deploy" },
    ]);
    expect(readChips(editor).text).toBe(prompt);
  });

  it("draws the skill's own emoji and falls back to the skill glyph otherwise", () => {
    const editor = loadPrompt("$review-follow-up $deploy $unknown ", [iconSkill, assetIconSkill]);
    const [emojiChip, assetChip, unknownChip] = readChips(editor).markup;

    expect(emojiChip).toContain('data-composer-skill-chip="true"');
    expect(emojiChip).toContain("🔧");
    expect(emojiChip).toContain("Review Follow-up");
    expect(emojiChip).not.toContain("<svg");
    expect(assetChip).toContain("<svg");
    expect(assetChip).not.toContain("/icons/deploy.png");
    expect(unknownChip).toContain("<svg");
    expect(unknownChip).toContain("Unknown");
  });

  it("keeps the icon through editor state serialization", () => {
    const saved = loadPrompt("$review-follow-up ", [iconSkill]).getEditorState().toJSON();
    expect(serializedChips(saved)).toMatchObject([
      { skillName: "review-follow-up", skillIcon: "🔧" },
    ]);

    const restored = createSkillEditor();
    restored.setEditorState(restored.parseEditorState(saved));
    const { markup, text } = readChips(restored);
    expect(markup[0]).toContain("🔧");
    expect(text).toBe("$review-follow-up ");
  });
});
