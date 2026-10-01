import { collectComposerInlineTokens } from "@akeru/shared/composerInlineTokens";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import type { NativeSyntheticEvent } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";
import { useBotNames } from "../state/bots";
import { useThreadTitles } from "../state/entities";
import {
  acknowledgeComposerNativeEvent,
  assumeComposerControlledState,
  isComposerNativeEcho,
  pruneAcknowledgedComposerNativeEvents,
  resolveComposerControlledEventCount,
  type ComposerNativeEventSnapshot,
} from "./composerEditorRevision";
import { composerFileIconUri, composerTokenLabel } from "./composerNativeTokenMetadata";
import type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from "./T3ComposerEditor.types";

const EMPTY_SKILLS: NonNullable<ComposerEditorProps["skills"]> = [];

/** Text and selection events carry the native revision they were emitted at. */
export type NativeComposerEditorEvent = NativeSyntheticEvent<{
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly eventCount: number;
}>;

export type NativePasteImagesEvent = NativeSyntheticEvent<{
  readonly uris: ReadonlyArray<string>;
}>;

export interface NativeComposerEditorRef {
  focus: () => Promise<void>;
  blur: () => Promise<void>;
  setSelection: (start: number, end: number) => Promise<void>;
}

/**
 * The controlled document shared by the iOS and Android native editors: inline
 * token chips, theme colors, and the revision bookkeeping that keeps a lagging
 * render from re-applying stale text or caret over newer native state. The
 * platform wrappers spread the returned props onto their native view and keep
 * their own typography, paste, and submit wiring.
 */
export function useComposerNativeDocument(input: {
  readonly ref: Ref<ComposerEditorHandle> | undefined;
  readonly value: string;
  readonly selection: ComposerEditorSelection | undefined;
  readonly skills: ComposerEditorProps["skills"];
  readonly onChangeText: (value: string) => void;
  readonly onSelectionChange: ((selection: ComposerEditorSelection) => void) | undefined;
}) {
  const { value, selection, onChangeText, onSelectionChange } = input;
  const skills = input.skills ?? EMPTY_SKILLS;
  const nativeRef = useRef<NativeComposerEditorRef>(null);
  const mostRecentEventCountRef = useRef(0);
  const [mostRecentEventCount, setMostRecentEventCount] = useState(0);
  const [, forceNativeEventRender] = useState(0);
  // The native editor mounts empty, so the snapshot history starts empty: the
  // first controlled payload must be a non-echo so a restored draft (or a
  // recycled native view) is applied rather than skipped.
  const nativeEventSnapshotsRef = useRef<ComposerNativeEventSnapshot[]>([]);
  const [initialConfirmedTokens] = useState(() => collectComposerInlineTokens(value));
  const confirmedTokensRef = useRef(initialConfirmedTokens);
  const textColor = useThemeColor("--color-foreground");
  const placeholderColor = useThemeColor("--color-placeholder");
  const chipBackground = useThemeColor("--color-subtle");
  const chipBorder = useThemeColor("--color-border");
  const chipText = useThemeColor("--color-foreground");
  const skillBackground = useThemeColor("--color-inline-skill-background");
  const skillBorder = useThemeColor("--color-inline-skill-border");
  const skillText = useThemeColor("--color-inline-skill-foreground");
  const fileTint = useThemeColor("--color-icon-muted");

  useImperativeHandle(
    input.ref,
    () => ({
      focus: () => void nativeRef.current?.focus(),
      blur: () => void nativeRef.current?.blur(),
      setSelection: (nextSelection) =>
        void nativeRef.current?.setSelection(nextSelection.start, nextSelection.end),
    }),
    [],
  );

  const skillLabels = useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill.displayName?.trim() || skill.name])),
    [skills],
  );

  const tokens = useMemo(() => {
    const next = collectComposerInlineTokens(value, {
      preserveTrailingFrom: confirmedTokensRef.current,
    });

    confirmedTokensRef.current = next;

    return next;
  }, [value]);

  const mentionedThreadIds = useMemo(
    () => tokens.flatMap((token) => (token.type === "thread-mention" ? [token.value] : [])),
    [tokens],
  );

  const threadTitles = useThreadTitles(mentionedThreadIds);

  const mentionedBotIds = useMemo(
    () => tokens.flatMap((token) => (token.type === "bot-mention" ? [token.value] : [])),
    [tokens],
  );

  const botNames = useBotNames(mentionedBotIds);

  const tokensJson = useMemo(
    () =>
      JSON.stringify(
        tokens.map((token) => ({
          type: token.type,
          source: token.source,
          start: token.start,
          end: token.end,
          label: composerTokenLabel(token, skillLabels, threadTitles, botNames),
          iconUri: token.type === "mention" ? composerFileIconUri(token.value) : null,
        })),
      ),
    [botNames, skillLabels, threadTitles, tokens],
  );

  // Every render resolves against the snapshot history, so a render whose
  // (value, selection) lags the acknowledged native state is stamped behind
  // the native revision and rejected by the editor instead of re-applying a
  // stale caret or stale text mid-typing.
  const controlledEventCount = resolveComposerControlledEventCount(
    value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );

  const acknowledgesLatestNativeEvent = isComposerNativeEcho(
    value,
    selection ?? null,
    mostRecentEventCount,
    nativeEventSnapshotsRef.current,
  );

  const isNativeEcho =
    controlledEventCount === mostRecentEventCount && acknowledgesLatestNativeEvent;

  const controlledDocumentJson = JSON.stringify({
    value,
    selection: isNativeEcho ? null : (selection ?? null),
    tokensJson,
    mostRecentEventCount: controlledEventCount,
    isNativeEcho,
  });

  useEffect(() => {
    if (!acknowledgesLatestNativeEvent) return;
    nativeEventSnapshotsRef.current = pruneAcknowledgedComposerNativeEvents(
      nativeEventSnapshotsRef.current,
      mostRecentEventCount,
    );
  }, [acknowledgesLatestNativeEvent, mostRecentEventCount]);
  useEffect(() => {
    // A native event that arrived after this render was committed moves the
    // acknowledged revision forward; the editor rejects this payload, so the
    // snapshot history must not assume it applied.
    if (isNativeEcho || controlledEventCount !== mostRecentEventCountRef.current) return;
    nativeEventSnapshotsRef.current = assumeComposerControlledState(
      nativeEventSnapshotsRef.current,
      controlledEventCount,
      value,
    );
  }, [value, controlledEventCount, isNativeEcho, controlledDocumentJson]);

  const acceptNativeEvent = useCallback(
    (eventCount: number, nextValue: string, nextSelection: ComposerEditorSelection) => {
      const acknowledgedEventCount = acknowledgeComposerNativeEvent(
        mostRecentEventCountRef.current,
        eventCount,
      );

      if (acknowledgedEventCount === null) {
        return false;
      }

      mostRecentEventCountRef.current = acknowledgedEventCount;
      nativeEventSnapshotsRef.current.push({
        eventCount: acknowledgedEventCount,
        value: nextValue,
        selection: nextSelection,
      });

      return acknowledgedEventCount;
    },
    [],
  );

  const themeJson = JSON.stringify({
    text: String(textColor),
    placeholder: String(placeholderColor),
    chipBackground: String(chipBackground),
    chipBorder: String(chipBorder),
    chipText: String(chipText),
    skillBackground: String(skillBackground),
    skillBorder: String(skillBorder),
    skillText: String(skillText),
    fileTint: String(fileTint),
  });

  return {
    nativeRef,
    controlledDocumentJson,
    themeJson,
    onComposerChange: (event: NativeComposerEditorEvent) => {
      const acknowledgedEventCount = acceptNativeEvent(
        event.nativeEvent.eventCount,
        event.nativeEvent.value,
        event.nativeEvent.selection,
      );

      if (acknowledgedEventCount === false) return;
      onChangeText(event.nativeEvent.value);
      onSelectionChange?.(event.nativeEvent.selection);
      setMostRecentEventCount(acknowledgedEventCount);
      forceNativeEventRender((sequence) => sequence + 1);
    },
    onComposerSelectionChange: (event: NativeComposerEditorEvent) => {
      const acknowledgedEventCount = acceptNativeEvent(
        event.nativeEvent.eventCount,
        event.nativeEvent.value,
        event.nativeEvent.selection,
      );

      if (acknowledgedEventCount === false) return;

      // A selection change can race a text mutation (Android emits it
      // mid-mutation, before the change event), so the payload can carry
      // post-edit text. It must reach the parent alongside the acknowledged
      // revision, or the next render stamps the stale draft at that revision
      // and can re-apply it over the newer native text.
      if (event.nativeEvent.value !== value) {
        onChangeText(event.nativeEvent.value);
      }

      onSelectionChange?.(event.nativeEvent.selection);
      setMostRecentEventCount(acknowledgedEventCount);
      forceNativeEventRender((sequence) => sequence + 1);
    },
  };
}
