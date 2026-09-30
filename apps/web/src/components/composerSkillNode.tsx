import {
  formatProviderSkillDisplayName,
  resolveProviderSkillTextIcon,
} from "@akeru/client-runtime/providerSkills";
import { type ServerProviderSkill } from "@akeru/contracts";
import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";

import {
  COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  INLINE_SKILL_CHIP_ICON_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "./composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// The composer's `$name` skill chip. Its text content is the `$name` token, so
// the prompt the composer submits is unchanged by the chip.

type SerializedComposerSkillNode = Spread<
  {
    skillName: string;
    skillLabel?: string;
    skillDescription?: string;
    skillIcon?: string;
    type: "composer-skill";
    version: 1;
  },
  SerializedLexicalNode
>;

function resolveSkillDescription(
  skill: Pick<ServerProviderSkill, "shortDescription" | "description">,
): string | null {
  const shortDescription = skill.shortDescription?.trim();
  if (shortDescription) {
    return shortDescription;
  }
  const description = skill.description?.trim();
  return description || null;
}

export type ComposerSkillMetadata = {
  label: string;
  description: string | null;
  icon: string | null;
};

export function skillMetadataByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyMap<string, ComposerSkillMetadata> {
  return new Map(
    skills.map((skill) => [
      skill.name,
      {
        label: formatProviderSkillDisplayName(skill),
        description: resolveSkillDescription(skill),
        icon: resolveProviderSkillTextIcon(skill),
      },
    ]),
  );
}

function ComposerSkillDecorator(props: {
  skillLabel: string;
  skillDescription: string | null;
  skillIcon: string | null;
}) {
  const chip = (
    <span
      className={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}
      contentEditable={false}
      spellCheck={false}
      data-composer-skill-chip="true"
    >
      {props.skillIcon ? (
        <span aria-hidden="true" className={INLINE_SKILL_CHIP_ICON_CLASS_NAME}>
          {props.skillIcon}
        </span>
      ) : (
        <span
          aria-hidden="true"
          className={INLINE_SKILL_CHIP_ICON_CLASS_NAME}
          dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
        />
      )}
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.skillLabel}</span>
    </span>
  );

  if (!props.skillDescription) {
    return chip;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="max-w-120 whitespace-normal leading-tight">
        {props.skillDescription}
      </TooltipPopup>
    </Tooltip>
  );
}

export class ComposerSkillNode extends DecoratorNode<React.ReactElement> {
  __skillName: string;
  __skillLabel: string;
  __skillDescription: string | null;
  __skillIcon: string | null;

  static override getType(): string {
    return "composer-skill";
  }

  static override clone(node: ComposerSkillNode): ComposerSkillNode {
    return new ComposerSkillNode(
      node.__skillName,
      node.__skillLabel,
      node.__skillDescription,
      node.__skillIcon,
      node.__key,
    );
  }

  static override importJSON(serializedNode: SerializedComposerSkillNode): ComposerSkillNode {
    return $applyNodeReplacement(
      new ComposerSkillNode(
        serializedNode.skillName,
        serializedNode.skillLabel ?? serializedNode.skillName,
        serializedNode.skillDescription ?? null,
        serializedNode.skillIcon ?? null,
      ),
    ).updateFromJSON(serializedNode);
  }

  constructor(
    skillName: string,
    skillLabel: string,
    skillDescription: string | null,
    skillIcon: string | null,
    key?: NodeKey,
  ) {
    super(key);
    const normalizedSkillName = skillName.startsWith("$") ? skillName.slice(1) : skillName;
    this.__skillName = normalizedSkillName;
    this.__skillLabel = skillLabel;
    this.__skillDescription = skillDescription;
    this.__skillIcon = skillIcon;
  }

  override exportJSON(): SerializedComposerSkillNode {
    return {
      ...super.exportJSON(),
      skillName: this.__skillName,
      skillLabel: this.__skillLabel,
      ...(this.__skillDescription ? { skillDescription: this.__skillDescription } : {}),
      ...(this.__skillIcon ? { skillIcon: this.__skillIcon } : {}),
      type: "composer-skill",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME;
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return `$${this.__skillName}`;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): React.ReactElement {
    return (
      <ComposerSkillDecorator
        skillLabel={this.__skillLabel}
        skillDescription={this.__skillDescription}
        skillIcon={this.__skillIcon}
      />
    );
  }
}

/** Creates the chip for `$name`, labelled from the provider catalog when the skill is known. */
export function $createComposerSkillNode(
  skillName: string,
  metadata: ComposerSkillMetadata | undefined,
): ComposerSkillNode {
  return $applyNodeReplacement(
    new ComposerSkillNode(
      skillName,
      metadata?.label ?? formatProviderSkillDisplayName({ name: skillName }),
      metadata?.description ?? null,
      metadata?.icon ?? null,
    ),
  );
}
