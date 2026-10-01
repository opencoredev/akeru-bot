import { requireNativeView } from "expo";
import { TextInputWrapper } from "expo-paste-input";
import type { Ref } from "react";
import type { ViewProps } from "react-native";
import { StyleSheet } from "react-native";
import { MOBILE_TYPOGRAPHY } from "../lib/typography";
import { useNativePaste } from "../lib/useNativePaste";
import { useFontFamily } from "../lib/useFontFamily";
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
  readonly singleLineCentered: boolean;
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

  const handlePaste = useNativePaste((uris) => onPasteImages?.(uris));
  const resolvedTextStyle = StyleSheet.flatten(textStyle) ?? {};
  const regularFontFamily = useFontFamily("regular");

  return (
    <TextInputWrapper onPaste={handlePaste} style={[{ minHeight: 0 }, style]}>
      <NativeView
        ref={editorDocument.nativeRef}
        controlledDocumentJson={editorDocument.controlledDocumentJson}
        themeJson={editorDocument.themeJson}
        placeholder={props.placeholder ?? ""}
        fontFamily={
          typeof resolvedTextStyle.fontFamily === "string"
            ? resolvedTextStyle.fontFamily
            : regularFontFamily
        }
        fontSize={
          typeof resolvedTextStyle.fontSize === "number"
            ? resolvedTextStyle.fontSize
            : MOBILE_TYPOGRAPHY.body.fontSize
        }
        lineHeight={
          typeof resolvedTextStyle.lineHeight === "number"
            ? resolvedTextStyle.lineHeight
            : MOBILE_TYPOGRAPHY.body.lineHeight
        }
        contentInsetVertical={contentInsetVertical}
        singleLineCentered={props.singleLineCentered ?? false}
        editable={props.editable ?? true}
        scrollEnabled={props.scrollEnabled ?? true}
        autoFocus={props.autoFocus ?? false}
        autoCorrect={props.autoCorrect ?? true}
        spellCheck={props.spellCheck ?? true}
        style={{ flex: 1, minHeight: 0 }}
        onComposerChange={editorDocument.onComposerChange}
        onComposerSelectionChange={editorDocument.onComposerSelectionChange}
        onComposerPasteImages={(event) => onPasteImages?.(event.nativeEvent.uris)}
        onComposerFocus={onFocus}
        onComposerBlur={onBlur}
      />
    </TextInputWrapper>
  );
}

export type {
  ComposerEditorHandle,
  ComposerEditorProps,
  ComposerEditorSelection,
} from "./T3ComposerEditor.types";
