import {
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  ApprovalRequestId,
  OrchestrationProposedPlanId,
  ThreadId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../lib/composerPathSearchState", () => ({
  useComposerPathSearch: () => ({ entries: [], error: null, isPending: false }),
}));
vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => false,
  useIsMobile: () => false,
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "color",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  useSidebarStageBackdropVariant: () => null,
  StageBackdropButtonArt: () => null,
}));
vi.mock("../ComposerPromptEditor", () => ({
  ComposerPromptEditor: (props: { placeholder: string; disabled?: boolean }) => (
    <div
      data-composer-prompt-editor="true"
      data-placeholder={props.placeholder}
      aria-disabled={props.disabled ? "true" : "false"}
    />
  ),
}));

import {
  composerTestEnvironmentId,
  composerTestModelName,
  makeChatComposerProps,
  makeComposerTestThread,
} from "../../test/chatComposerProps";
import { EMPTY_PRODUCT_FEEDBACK_DRAFT, useProductFeedbackStore } from "../../productFeedbackStore";
import { ChatComposer, respondToComposerApproval } from "./ChatComposer";

const environmentId = composerTestEnvironmentId;

beforeEach(() => {
  useProductFeedbackStore.setState({
    open: false,
    picking: false,
    draft: EMPTY_PRODUCT_FEEDBACK_DRAFT,
  });
});

/** Launch controls LEO-215 removes from the primary composer. */
function expectNoLaunchControls(markup: string) {
  // Model picker trigger (the trigger label rendered the model name). The
  // picker itself survives as a closed dialog, so no content is in markup.
  expect(markup).not.toContain(composerTestModelName);
  expect(markup).not.toContain("data-model-picker-content");
  expect(markup).not.toContain("data-chat-provider-model-picker");
  // Runtime/permission mode select.
  expect(markup).not.toContain("Runtime mode");
  expect(markup).not.toContain("Full access");
  expect(markup).not.toContain("Supervised");
  expect(markup).not.toContain("Auto-accept edits");
  // Plan/Build interaction toggle and reasoning traits.
  expect(markup).not.toContain(">Plan<");
  expect(markup).not.toContain(">Build<");
  expect(markup).not.toContain("plan mode");
  // Compact overflow menu that hosted the same controls.
  expect(markup).not.toContain("More composer controls");
  // Workspace/branch/worktree chips never render inside the composer.
  expect(markup).not.toContain("Local checkout");
  expect(markup).not.toContain("Current checkout");
  expect(markup).not.toContain("New worktree");
}

describe("ChatComposer launch-control removal", () => {
  it("renders a new draft as a plain chat box with send but no launch controls", () => {
    const markup = renderToStaticMarkup(<ChatComposer {...makeChatComposerProps()} />);

    expect(markup).toContain('data-chat-composer-footer="true"');
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).toContain("Ask anything, @tag files/folders, $use skills, or / for commands");
    expectNoLaunchControls(markup);
  });

  it("renders an existing running thread with stop control and no launch controls", () => {
    const markup = renderToStaticMarkup(
      <ChatComposer
        {...makeChatComposerProps({
          composerDraftTarget: {
            environmentId,
            threadId: ThreadId.make("thread-1"),
          },
          routeKind: "server",
          draftId: null,
          isServerThread: true,
          isLocalDraftThread: false,
          activeThread: makeComposerTestThread({
            worktreePath: "/repo/.worktrees/t3-1",
            branch: "main",
          }),
          phase: "running",
        })}
      />,
    );

    expect(markup).toContain('aria-label="Stop generation"');
    expectNoLaunchControls(markup);
    // The thread keeps its worktree, but no chip renders for it.
    expect(markup).not.toContain(".worktrees/t3-1");
    expect(markup).not.toContain(">main<");
  });

  it("keeps the pending-approval surface reachable", () => {
    const approval = {
      requestId: ApprovalRequestId.make("approval-1"),
      requestKind: "command" as const,
      createdAt: "2026-03-01T00:00:00.000Z",
      detail: "rm -rf node_modules",
    };
    const markup = renderToStaticMarkup(
      <ChatComposer
        {...makeChatComposerProps({
          composerDraftTarget: {
            environmentId,
            threadId: ThreadId.make("thread-1"),
          },
          routeKind: "server",
          draftId: null,
          isServerThread: true,
          isLocalDraftThread: false,
          phase: "running",
          activePendingApproval: approval,
          pendingApprovals: [approval],
        })}
      />,
    );

    expect(markup).toContain("rm -rf node_modules");
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Enable Auto Review");
    expect(markup).toContain("Never");
    expectNoLaunchControls(markup);
  });

  it("keeps the pending user-input questions reachable", () => {
    const pendingUserInput = {
      requestId: ApprovalRequestId.make("request-1"),
      createdAt: "2026-03-01T00:00:00.000Z",
      questions: [
        {
          id: "question-1",
          header: "Approach",
          question: "Which approach should the migration take?",
          options: [{ label: "Incremental", description: "Move one module at a time" }],
          multiSelect: false,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <ChatComposer
        {...makeChatComposerProps({
          composerDraftTarget: {
            environmentId,
            threadId: ThreadId.make("thread-1"),
          },
          routeKind: "server",
          draftId: null,
          isServerThread: true,
          isLocalDraftThread: false,
          pendingUserInputs: [pendingUserInput],
          activePendingProgress: {
            questionIndex: 0,
            isLastQuestion: true,
            canAdvance: true,
            customAnswer: "",
            activeQuestion: { id: "question-1" },
          },
        })}
      />,
    );

    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expectNoLaunchControls(markup);
  });

  it("keeps the plan follow-up actions reachable", () => {
    const markup = renderToStaticMarkup(
      <ChatComposer
        {...makeChatComposerProps({
          composerDraftTarget: {
            environmentId,
            threadId: ThreadId.make("thread-1"),
          },
          routeKind: "server",
          draftId: null,
          isServerThread: true,
          isLocalDraftThread: false,
          showPlanFollowUpPrompt: true,
          activeProposedPlan: {
            id: OrchestrationProposedPlanId.make("plan-1"),
            turnId: null,
            planMarkdown: "# Ship the widget\n1. Do the thing",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-01T00:00:00.000Z",
          },
        })}
      />,
    );

    expect(markup).toContain(">Implement</button>");
    expect(markup).toContain('aria-label="Implementation actions"');
    expectNoLaunchControls(markup);
  });
});

describe("ChatComposer product feedback approval", () => {
  it("opens a valid draft and accepts without sending feedback", async () => {
    const requestId = ApprovalRequestId.make("feedback-approval");
    const respond = vi.fn(async () => undefined);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await respondToComposerApproval(
      {
        requestId,
        requestKind: "command",
        createdAt: "2026-08-30T00:00:00.000Z",
        toolName: AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
        args: { feedback: "The action was unclear." },
      },
      requestId,
      "accept",
      respond,
    );

    expect(useProductFeedbackStore.getState()).toMatchObject({
      open: true,
      draft: { feedback: "The action was unclear." },
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(requestId, "accept");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("declines invalid feedback arguments without opening a draft", async () => {
    const requestId = ApprovalRequestId.make("invalid-feedback-approval");
    const respond = vi.fn(async () => undefined);

    await respondToComposerApproval(
      {
        requestId,
        requestKind: "command",
        createdAt: "2026-08-30T00:00:00.000Z",
        toolName: AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
        args: { feedback: "x".repeat(5_000) },
      },
      requestId,
      "accept",
      respond,
    );

    expect(useProductFeedbackStore.getState().open).toBe(false);
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
  });
});
