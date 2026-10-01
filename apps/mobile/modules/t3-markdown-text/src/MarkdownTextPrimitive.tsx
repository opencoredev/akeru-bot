import { Predicate } from "effect";
import React from "react";
import {
  Platform,
  StyleSheet,
  Text as RNText,
  type TextProps,
  type ViewStyle,
  type HostComponent,
  type StyleProp,
} from "react-native";
import NativeTextRun from "./T3MarkdownTextRunNativeComponent";
import NativeText from "./T3MarkdownTextNativeComponent";
import { flattenStyles } from "./util";

// The public primitive forwards TextProps. Codegen describes only the view props
// and targeted events, so the bridge needs the inherited text callback contract.
type InheritedTextProps<Native> = Omit<Native, keyof TextProps> &
  Omit<TextProps, "style"> & {
    readonly style?: StyleProp<ReturnType<typeof flattenStyles>>;
  };

// SAFETY: This is the same native host component; only its inherited TextProps are exposed.
const T3MarkdownTextRunNativeComponent = NativeTextRun as HostComponent<
  InheritedTextProps<React.ComponentProps<typeof NativeTextRun>>
>;

// SAFETY: This is the same native host component; only its inherited TextProps are exposed.
const T3MarkdownTextNativeComponent = NativeText as HostComponent<
  InheritedTextProps<React.ComponentProps<typeof NativeText>>
>;

const TextAncestorContext = React.createContext<[boolean, ViewStyle]>([
  false,
  StyleSheet.create({}),
]);

const textDefaults: TextProps = {
  allowFontScaling: true,
  selectable: true,
};

const useTextAncestorContext = () => React.useContext(TextAncestorContext);

/**
 * Event fired by `onSelectionChange`. `start`/`end` are 0-based UTF-16 indices
 * into the rendered string. `start === end` means the selection was cleared.
 */
export type SelectionChangeEvent = {
  nativeEvent: { target: number; start: number; end: number };
};

export type MarkdownTextPrimitiveProps = TextProps & {
  uiTextView?: boolean;
  /**
   * Fired when the native text selection changes. Only fires on iOS when
   * `uiTextView` is true. Note: fires on every selection-edge adjustment
   * (e.g. dragging a selection handle), so consumers driving expensive work
   * off this event should debounce.
   */
  onSelectionChange?: (event: SelectionChangeEvent) => void;
};

function MarkdownTextPrimitiveChild({ style, children, ...rest }: MarkdownTextPrimitiveProps) {
  const [isAncestor, rootStyle] = useTextAncestorContext();

  // Flatten the styles, and apply the root styles when needed
  const flattenedStyle = React.useMemo(() => flattenStyles(rootStyle, style), [rootStyle, style]);

  const contextValue = React.useMemo<[boolean, ViewStyle]>(
    () => [true, flattenedStyle],
    [flattenedStyle],
  );

  let childPosition = 0;

  const nativeChildren = React.Children.toArray(children).map((child) => {
    const position = childPosition;
    childPosition += 1;

    if (React.isValidElement(child)) {
      return child;
    }

    if (!Predicate.isString(child) && !Predicate.isNumber(child)) {
      return null;
    }

    const text = child.toString();

    return (
      <T3MarkdownTextRunNativeComponent
        key={`text-${position}-${text.length}-${text}`}
        style={flattenedStyle}
        text={text}
        {...rest}
      />
    );
  });

  if (!isAncestor) {
    return (
      <TextAncestorContext.Provider value={contextValue}>
        <T3MarkdownTextNativeComponent
          {...textDefaults}
          {...rest}
          // ellipsizeMode={rest.ellipsizeMode ?? rest.lineBreakMode ?? 'tail'}
          style={[flattenedStyle]}
          onPress={undefined}
          onLongPress={undefined}
        >
          {nativeChildren}
        </T3MarkdownTextNativeComponent>
      </TextAncestorContext.Provider>
    );
  }

  return <>{nativeChildren}</>;
}

function MarkdownTextPrimitiveInner(props: MarkdownTextPrimitiveProps) {
  const [isAncestor] = useTextAncestorContext();

  // Even if the uiTextView prop is set, we can still default to using
  // normal selection (i.e. base RN text) if the text doesn't need to be
  // selectable
  if ((!props.selectable || !props.uiTextView) && !isAncestor) {
    return <RNText {...props} />;
  }

  return <MarkdownTextPrimitiveChild {...props} />;
}

export function MarkdownTextPrimitive(props: MarkdownTextPrimitiveProps) {
  if (Platform.OS !== "ios") {
    return <RNText {...props} />;
  }

  return <MarkdownTextPrimitiveInner {...props} />;
}
