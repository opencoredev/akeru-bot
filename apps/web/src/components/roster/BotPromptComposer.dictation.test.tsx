import type { DictationDraft } from "@t3tools/client-runtime/dictation";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

type Session = ReturnType<
  typeof import("@t3tools/client-runtime/dictation").createDictationSession
>;
type DictationInput = {
  readonly getDraft: () => Omit<DictationDraft, "identity">;
  readonly applyDraft: (draft: DictationDraft) => void;
};

const fake = vi.hoisted(() => ({
  session: null as Session | null,
  input: null as DictationInput | null,
  transcribe: null as unknown as Mock<() => Promise<string>>,
}));

vi.mock("../../i18n", async () => {
  const { createTranslator } = await import("@t3tools/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useI18n: () => ({ ...translator, t: translator.translate }) };
});
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => {},
    useId: () => "id",
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("motion/react", () => ({
  AnimatePresence: () => null,
  motion: { div: () => null },
  useReducedMotion: () => true,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: Symbol("keybindings") }));
vi.mock("./BotPromptCommandMenu", () => ({ BotPromptCommandMenu: () => null }));
vi.mock("../../composerDraftStore", () => ({ hydrateImagesFromPersisted: () => [] }));
vi.mock("../../lib/imageCompression", () => ({ compressImageForStash: vi.fn() }));
vi.mock("../../promptStashStore", () => ({
  MAX_STASH_ENTRIES: 10,
  partitionStashAttachments: vi.fn(),
  usePromptStashStore: (selector: (store: object) => unknown) =>
    selector({
      entries: [],
      stashEntry: vi.fn(),
      takeEntry: vi.fn(),
      finalizeEntryImages: vi.fn(),
    }),
}));
vi.mock("./rosterStore", () => ({
  useRosterStore: (selector: (store: { bots: [] }) => unknown) => selector({ bots: [] }),
}));
vi.mock("./BotComposerModelControl", () => ({ BotComposerModelControl: () => null }));
vi.mock("./BotPromptMentions", () => ({
  BotPromptMentionChips: () => null,
  BotPromptMentionMenu: () => null,
  draftHasMentionChips: () => false,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
// The real session runs behind the environment binding: capture succeeds, transcription fails.
vi.mock("../../lib/useEnvironmentComposerDictation", async () => {
  const { createDictationSession, dictationControlStatus } =
    await import("@t3tools/client-runtime/dictation");
  const identity = { environmentId: "environment", threadId: "Scout", draftId: "Scout" };
  return {
    useEnvironmentComposerDictation: (input: DictationInput & { generation: number }) => {
      fake.input = input;
      const draft = () => ({ identity: { ...identity, generation: 0 }, ...input.getDraft() });
      fake.session ??= createDictationSession({
        capture: async () => ({
          stop: async () => ({
            bytes: new Uint8Array([1]),
            mediaType: "audio/webm",
            durationMs: 900,
          }),
          dispose: () => {},
        }),
        transcribe: fake.transcribe,
        updateDraft: (update) => fake.input!.applyDraft(update(draft())),
        schedule: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
        cancelSchedule: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
      });
      const session = fake.session;
      return {
        status: dictationControlStatus(session.status),
        unavailableReason: null,
        errorMessage: session.status === "error" ? "Transcription failed. Try again." : null,
        onStart: () => session.start(draft()),
        onRelease: () => session.finish(),
        onCancel: () => session.cancel(),
      };
    },
  };
});

import { DictationControls, type DictationControlsProps } from "../chat/DictationControls";
import { BotPromptComposer } from "./BotPromptComposer";
import type { BotPromptAttachment } from "./BotPromptAttachments";

type Element = ReactElement<Record<string, unknown>>;

function render() {
  hooks.beginRender();
  const tree = BotPromptComposer({ botName: "Scout", disabled: false, onSubmit: vi.fn() });
  const slot = visitElements(tree, (element) => element.type === DictationControls);
  // Render the send-slot controls in the same pass so their hooks keep stable slots.
  const controls = slot ? DictationControls(slot.props as unknown as DictationControlsProps) : null;
  const find = (label: string) =>
    visitElements([tree, controls], (element) => element.props["aria-label"] === label);
  return {
    textarea: visitElements(tree, (element) => element.type === "textarea") as Element,
    fileInput: visitElements(tree, (element) => element.props.type === "file") as Element,
    attachments: () =>
      (visitElements(tree, (element) => Array.isArray(element.props.attachments)) as Element).props
        .attachments as BotPromptAttachment[],
    find,
  };
}

async function retryDictation() {
  (render().find("Retry dictation")!.props.onClick as (event: { detail: number }) => void)({
    detail: 0,
  });
  await vi.waitFor(() => expect(fake.session!.status).toBe("recording"));
  (render().find("Stop dictation")!.props.onClick as (event: { detail: number }) => void)({
    detail: 0,
  });
  await vi.waitFor(() => expect(fake.session!.status).toBe("error"));
}

beforeEach(() => {
  hooks.reset();
  fake.session = null;
  fake.input = null;
  fake.transcribe = vi.fn(async () => {
    throw new Error("Transcription failed. Try again.");
  });
});

describe("BotPromptComposer dictation failure", () => {
  it("keeps typed text and attachments through retry and dismiss", async () => {
    const view = render();
    (view.textarea.props.onChange as (event: unknown) => void)({
      currentTarget: { value: "Summarize the attached notes" },
    });
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    (view.fileInput.props.onChange as (event: unknown) => void)({
      currentTarget: { files: [file], value: "" },
    });
    const seeded = render();
    expect(seeded.find("Send message")).not.toBeNull();
    const [attachment] = seeded.attachments();
    expect(attachment?.file).toBe(file);

    // A draft shows Send, so drive the composer's session directly, as a hold that began earlier would.
    await fake.session!.start({
      identity: {
        environmentId: "environment",
        threadId: "Scout",
        draftId: "Scout",
        generation: 0,
      },
      ...fake.input!.getDraft(),
    });
    await fake.session!.finish();
    expect(fake.session!.status).toBe("error");

    const failed = render();
    expect(failed.find("Retry dictation")).not.toBeNull();
    expect(failed.find("Dismiss dictation error")).not.toBeNull();
    expect(failed.find("Send message")).toBeNull();

    await retryDictation();
    expect(fake.transcribe).toHaveBeenCalledTimes(2);
    const retried = render();
    expect(retried.textarea.props.value).toBe("Summarize the attached notes");
    expect(retried.attachments()).toEqual([attachment]);
    expect(retried.attachments()[0]).toBe(attachment);

    (retried.find("Dismiss dictation error")!.props.onClick as () => void)();
    expect(fake.session!.status).toBe("cancelled");
    const dismissed = render();
    expect(dismissed.find("Retry dictation")).toBeNull();
    expect(dismissed.find("Send message")?.props.disabled).toBe(false);
    expect(dismissed.textarea.props.value).toBe("Summarize the attached notes");
    expect(dismissed.attachments()[0]).toBe(attachment);
  });
});
