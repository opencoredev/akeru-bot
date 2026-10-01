import { serializeComposerFileLink } from "@akeru/shared/composerTrigger";
import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { createContext } from "react";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "~/lib/terminalContext";
import { basenameOfPath } from "~/pierre-icons";
import { ComposerPendingTerminalContextChip } from "../chat/ComposerPendingTerminalContexts";
import { FILE_TAG_CHIP_CLASS_NAME, FileTagChipContent } from "../chat/FileTagChip";
import { COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME } from "../composerInlineChip";
import { ComposerSkillNode } from "../composerSkillNode";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolvedThemeFromDocument } from "./composerTheme";

type SerializedComposerMentionNode = Spread<
  {
    path: string;
    type: "composer-mention";
    version: 1;
  },
  SerializedLexicalNode
>;

type SerializedComposerTerminalContextNode = Spread<
  {
    context: TerminalContextDraft;
    type: "composer-terminal-context";
    version: 1;
  },
  SerializedLexicalNode
>;

export const ComposerTerminalContextActionsContext = createContext<{
  onRemoveTerminalContext: (contextId: string) => void;
}>({
  onRemoveTerminalContext: () => {},
});

function ComposerMentionDecorator(props: { path: string }) {
  const theme = resolvedThemeFromDocument();
  const chip = (
    <span
      className={FILE_TAG_CHIP_CLASS_NAME}
      contentEditable={false}
      spellCheck={false}
      data-composer-mention-chip="true"
    >
      <FileTagChipContent path={props.path} label={basenameOfPath(props.path)} theme={theme} />
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="max-w-120 whitespace-normal leading-tight wrap-anywhere">
        {props.path}
      </TooltipPopup>
    </Tooltip>
  );
}

export class ComposerMentionNode extends DecoratorNode<React.ReactElement> {
  __path: string;

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(node.__path, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode): ComposerMentionNode {
    return $createComposerMentionNode(serializedNode.path).updateFromJSON(serializedNode);
  }

  constructor(path: string, key?: NodeKey) {
    super(key);
    this.__path = path;
  }

  override exportJSON(): SerializedComposerMentionNode {
    return {
      ...super.exportJSON(),
      path: this.__path,
      type: "composer-mention",
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
    return serializeComposerFileLink(this.__path);
  }

  override isInline(): true {
    return true;
  }

  override decorate(): React.ReactElement {
    return <ComposerMentionDecorator path={this.__path} />;
  }
}

export function $createComposerMentionNode(path: string): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(path));
}

function ComposerTerminalContextDecorator(props: { context: TerminalContextDraft }) {
  return <ComposerPendingTerminalContextChip context={props.context} />;
}

export class ComposerTerminalContextNode extends DecoratorNode<React.ReactElement> {
  __context: TerminalContextDraft;

  static override getType(): string {
    return "composer-terminal-context";
  }

  static override clone(node: ComposerTerminalContextNode): ComposerTerminalContextNode {
    return new ComposerTerminalContextNode(node.__context, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerTerminalContextNode,
  ): ComposerTerminalContextNode {
    return $createComposerTerminalContextNode(serializedNode.context);
  }

  constructor(context: TerminalContextDraft, key?: NodeKey) {
    super(key);
    this.__context = context;
  }

  override exportJSON(): SerializedComposerTerminalContextNode {
    return {
      ...super.exportJSON(),
      context: this.__context,
      type: "composer-terminal-context",
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
    return INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): React.ReactElement {
    return <ComposerTerminalContextDecorator context={this.__context} />;
  }
}

export function $createComposerTerminalContextNode(
  context: TerminalContextDraft,
): ComposerTerminalContextNode {
  return $applyNodeReplacement(new ComposerTerminalContextNode(context));
}

export type ComposerInlineTokenNode =
  | ComposerMentionNode
  | ComposerSkillNode
  | ComposerTerminalContextNode;

export function isComposerInlineTokenNode(
  candidate: unknown,
): candidate is ComposerInlineTokenNode {
  return (
    candidate instanceof ComposerMentionNode ||
    candidate instanceof ComposerSkillNode ||
    candidate instanceof ComposerTerminalContextNode
  );
}
