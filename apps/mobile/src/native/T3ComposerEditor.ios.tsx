import { Predicate } from "effect";
import { requireNativeView } from "expo";
import type { Ref } from "react";
import type { StyleProp, ViewProps, ViewStyle } from "react-native";
import { StyleSheet } from "react-native";
import { useFontFamily } from "../lib/useFontFamily";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import type { ComposerEditorProps } from "./T3ComposerEditor.types";
import {
  useComposerNativeDocument,
  type NativeComposerEditorEvent,
  type NativeComposerEditorRef,
  type NativePasteImagesEvent,
} from "./useComposerNativeDocument";

const NATIVE_MODULE_NAME = "T3ComposerEditor";

interface NativeComposerEditorProps extends ViewProps {
  readonly ref?: Ref<NativeComposerEditorRef>;
  readonly controlledDocumentJson: string;
  readonly themeJson: string;
  readonly placeholder: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly contentInsetVertical: number;
  readonly editable: boolean;
  readonly scrollEnabled: boolean;
  readonly autoFocus: boolean;
  readonly autoCorrect: boolean;
  readonly spellCheck: boolean;
  readonly onComposerChange: (event: NativeComposerEditorEvent) => void;
  readonly onComposerSelectionChange?: (event: NativeComposerEditorEvent) => void;
  readonly onComposerPasteImages?: (event: NativePasteImagesEvent) => void;
  readonly onComposerFocus?: () => void;
  readonly onComposerBlur?: () => void;
  readonly onComposerSubmit?: () => void;
}

const NativeView = requireNativeView<NativeComposerEditorProps>(NATIVE_MODULE_NAME);

export function ComposerEditor({
  ref,
  skills,
  selection,
  style,
  textStyle,
  onChangeText,
  onSelectionChange,
  onPasteImages,
  onFocus,
  onBlur,
  onSubmit,
  contentInsetVertical = 0,
  ...props
}: ComposerEditorProps) {
  const editorDocument = useComposerNativeDocument({
    ref,
    value: props.value,
    selection,
    skills,
    onChangeText,
    onSelectionChange,
  });

  const bodyText = useScaledTextRole("body");
  const fontFamily = useFontFamily("regular");
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {};

  return (
    <NativeView
      ref={editorDocument.nativeRef}
      controlledDocumentJson={editorDocument.controlledDocumentJson}
      themeJson={editorDocument.themeJson}
      placeholder={props.placeholder ?? ""}
      fontFamily={
        Predicate.isString(resolvedTextStyle.fontFamily) ? resolvedTextStyle.fontFamily : fontFamily
      }
      fontSize={
        Predicate.isNumber(resolvedTextStyle.fontSize)
          ? resolvedTextStyle.fontSize
          : bodyText.fontSize
      }
      lineHeight={
        Predicate.isNumber(resolvedTextStyle.lineHeight)
          ? resolvedTextStyle.lineHeight
          : bodyText.lineHeight
      }
      contentInsetVertical={contentInsetVertical}
      editable={props.editable ?? true}
      scrollEnabled={props.scrollEnabled ?? true}
      autoFocus={props.autoFocus ?? false}
      autoCorrect={props.autoCorrect ?? true}
      spellCheck={props.spellCheck ?? true}
      style={style as StyleProp<ViewStyle>}
      onComposerChange={editorDocument.onComposerChange}
      onComposerSelectionChange={editorDocument.onComposerSelectionChange}
      onComposerPasteImages={(event) => onPasteImages?.(event.nativeEvent.uris)}
      onComposerFocus={onFocus}
      onComposerBlur={onBlur}
      onComposerSubmit={onSubmit}
    />
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from "./T3ComposerEditor.types";
