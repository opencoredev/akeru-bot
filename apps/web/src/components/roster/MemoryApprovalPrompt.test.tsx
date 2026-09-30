import {
  AkeruMemoryCandidateId,
  BotId,
  EnvironmentId,
  ThreadId,
  type AkeruMemoryApprovalRequest,
} from "@akeru/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  mutateFact: vi.fn(async (_input: unknown) => ({ _tag: "Success" as const })),
  // State the next render starts from, in hook order; empty means each hook's initial value.
  states: [] as unknown[],
  setState: vi.fn((_value: unknown) => {}),
}));

// Hooks run outside a renderer so the element tree exposes each button handler.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: <T,>(factory: () => T) => factory(),
    useState: <T,>(initial: T) => [
      mocks.states.length > 0 ? mocks.states.shift() : initial,
      mocks.setState,
    ],
  };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [{ id: "bot-grace", name: "Grace" }],
}));
vi.mock("../../i18n", async () => {
  const { createTranslator } = await import("@akeru/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useI18n: () => ({ ...translator, t: translator.translate }) };
});
vi.mock("../../state/bots", () => ({ environmentBotsAtom: () => Symbol("bots") }));
vi.mock("../../state/memory", () => ({ memoryEnvironment: { mutateFact: Symbol("mutate") } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.mutateFact }));

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { MemoryApprovalPrompt } from "./MemoryApprovalPrompt";

type ButtonElement = ReactElement<{ children: ReactNode; onClick: () => void }>;

type TextareaElement = ReactElement<{
  onKeyDown: (event: {
    key: string;
    nativeEvent: { isComposing: boolean };
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => void;
}>;

function textarea(node: ReactNode): TextareaElement | undefined {
  if (Array.isArray(node)) return node.map(textarea).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === Textarea) return node as TextareaElement;
  return textarea(node.props.children);
}

function buttons(node: ReactNode): ButtonElement[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  if (node.type === Button) return [node as ButtonElement];
  return buttons(node.props.children);
}

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-ada"),
};

const approval = (
  candidateId: string,
  sensitive = false,
  authorBotId: string | null = "bot-ada",
): AkeruMemoryApprovalRequest => ({
  candidateId: AkeruMemoryCandidateId.make(candidateId),
  fact: "Deploys happen on Fridays.",
  scope: "project",
  sensitive,
  sourceThreadId: threadRef.threadId,
  authorBotId: authorBotId === null ? null : BotId.make(authorBotId),
  affectedBotIds: [BotId.make("bot-ada"), BotId.make("bot-grace")],
});

describe("MemoryApprovalPrompt", () => {
  beforeEach(() => {
    mocks.mutateFact.mockClear();
    mocks.setState.mockClear();
    mocks.states = [];
  });

  it("shows the oldest pending fact with who can read it", () => {
    const markup = renderToStaticMarkup(
      <MemoryApprovalPrompt
        threadRef={threadRef}
        approvals={[approval("candidate-1", true), approval("candidate-2")]}
        currentBotId="bot-ada"
      />,
    );
    expect(markup).toContain('data-testid="memory-approval-prompt"');
    expect(markup).toContain("Save to project memory?");
    expect(markup).toContain("Sensitive, always needs approval");
    expect(markup).toContain("1 of 2");
    expect(markup).toContain("Deploys happen on Fridays.");
    expect(markup).toContain("Available to this bot, Grace");
    // Attaches to the prompt box like the provider approval card.
    expect(markup).toContain("rounded-t-[1.65rem]");
    expect(markup).not.toContain("animate-");
  });

  it("names the bot that proposed the fact, with a fallback when it is unknown", () => {
    const render = (authorBotId: string | null) =>
      renderToStaticMarkup(
        <MemoryApprovalPrompt
          threadRef={threadRef}
          approvals={[approval("candidate-1", false, authorBotId)]}
          currentBotId="bot-ada"
        />,
      );
    expect(render("bot-grace")).toContain("Grace wants to save this");
    expect(render("bot-missing")).toContain("A bot wants to save this");
    expect(render(null)).toContain("A bot wants to save this");
    expect(render("bot-grace")).not.toContain("Sensitive");
  });

  it("renders nothing once every request is decided", () => {
    expect(
      renderToStaticMarkup(
        <MemoryApprovalPrompt threadRef={threadRef} approvals={[]} currentBotId={null} />,
      ),
    ).toBe("");
  });

  it.each([
    ["Approve", { candidateId: "candidate-1", decision: "approve" }],
    ["Reject", { candidateId: "candidate-1", decision: "reject" }],
  ] as const)("%s decides the candidate for this chat", async (label, decision) => {
    const tree = MemoryApprovalPrompt({
      threadRef,
      approvals: [approval("candidate-1")],
      currentBotId: "bot-ada",
    });
    const target = buttons(tree).find((item) => item.props.children === label);
    expect(target).toBeDefined();
    target?.props.onClick();
    await vi.waitFor(() => expect(mocks.mutateFact).toHaveBeenCalledTimes(1));
    expect(mocks.mutateFact).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        mutation: { operation: "candidate.decide", decision },
      },
    });
  });

  it("cancels an edit on Escape without letting the key reach other UI", () => {
    const escape = (isComposing: boolean) => {
      mocks.states = [{ candidateId: "candidate-1", fact: "Deploys happen on Mondays." }];
      mocks.setState.mockClear();
      const tree = MemoryApprovalPrompt({
        threadRef,
        approvals: [approval("candidate-1")],
        currentBotId: "bot-ada",
      });
      const event = {
        key: "Escape",
        nativeEvent: { isComposing },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      textarea(tree)?.props.onKeyDown(event);
      return event;
    };

    const event = escape(false);
    expect(mocks.setState).toHaveBeenCalledWith(null);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();

    // Escape that closes an IME candidate list leaves the edit open.
    const composing = escape(true);
    expect(mocks.setState).not.toHaveBeenCalled();
    expect(composing.stopPropagation).not.toHaveBeenCalled();
  });
});
