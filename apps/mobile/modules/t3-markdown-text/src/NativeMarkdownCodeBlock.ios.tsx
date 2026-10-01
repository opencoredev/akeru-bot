import { useEffect, useState } from "react";
import { ScrollView, Text, useColorScheme, View } from "react-native";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import { CopyTextButton } from "./CopyTextButton";
import { MarkdownTextPrimitive } from "./MarkdownTextPrimitive";
import type {
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
  NativeMarkdownTextStyle,
} from "./SelectableMarkdownText.types";
import { nodeText } from "./nativeMarkdownNodes";

type HighlightedCode = ReadonlyArray<ReadonlyArray<MarkdownHighlightedToken>>;

const highlightedCodeCache = new Map<string, HighlightedCode>();
const highlightedCodePromiseCache = new Map<string, Promise<HighlightedCode>>();
const HIGHLIGHTED_CODE_CACHE_LIMIT = 64;

/** Code inside markdown scales with the base text size (12pt at the default 15pt body). */
function codeBlockFontSize(textStyle: NativeMarkdownTextStyle): number {
  return Math.max(10, Math.round(textStyle.fontSize * 0.8));
}

function codeBlockLineHeight(textStyle: NativeMarkdownTextStyle): number {
  return codeBlockFontSize(textStyle) + 6;
}

function codeHighlightCacheKey(
  code: string,
  language: string | undefined,
  theme: "light" | "dark",
): string {
  return `${theme}:${language ?? "text"}:${code}`;
}

function cacheHighlightedCode(key: string, tokens: HighlightedCode): void {
  highlightedCodeCache.delete(key);
  highlightedCodeCache.set(key, tokens);

  while (highlightedCodeCache.size > HIGHLIGHTED_CODE_CACHE_LIMIT) {
    const oldestKey = highlightedCodeCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    highlightedCodeCache.delete(oldestKey);
  }
}

function loadHighlightedCode(
  code: string,
  language: string | undefined,
  theme: "light" | "dark",
  highlightCode: MarkdownCodeHighlighter,
): Promise<HighlightedCode> {
  const key = codeHighlightCacheKey(code, language, theme);
  const cached = highlightedCodeCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = highlightedCodePromiseCache.get(key);
  if (pending) {
    return pending;
  }

  const promise = highlightCode({ code, language, theme })
    .then((tokens) => {
      cacheHighlightedCode(key, tokens);
      highlightedCodePromiseCache.delete(key);
      return tokens;
    })
    .catch((error) => {
      highlightedCodePromiseCache.delete(key);
      throw error;
    });
  highlightedCodePromiseCache.set(key, promise);
  return promise;
}

function useHighlightedCode(
  code: string,
  language: string | undefined,
  theme: "light" | "dark",
  highlightCode: MarkdownCodeHighlighter,
): HighlightedCode | null {
  const key = codeHighlightCacheKey(code, language, theme);
  const [highlighted, setHighlighted] = useState<{
    readonly key: string;
    readonly tokens: HighlightedCode | null;
  }>(() => ({
    key,
    tokens: highlightedCodeCache.get(key) ?? null,
  }));

  useEffect(() => {
    let active = true;
    const cached = highlightedCodeCache.get(key);
    if (cached) {
      cacheHighlightedCode(key, cached);
      setHighlighted({ key, tokens: cached });
      return () => {
        active = false;
      };
    }

    void loadHighlightedCode(code, language, theme, highlightCode)
      .then((tokens) => {
        if (active) {
          setHighlighted({ key, tokens });
        }
      })
      .catch(() => {
        if (active) {
          setHighlighted({ key, tokens: null });
        }
      });
    return () => {
      active = false;
    };
  }, [code, highlightCode, key, language, theme]);

  return highlighted.key === key ? highlighted.tokens : null;
}

function HighlightedCodeText(props: {
  readonly content: string;
  readonly highlighted: HighlightedCode | null;
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  if (!props.highlighted) {
    return (
      <MarkdownTextPrimitive
        uiTextView
        selectable
        style={{
          color: props.textStyle.codeColor,
          fontFamily: "ui-monospace",
          fontSize: codeBlockFontSize(props.textStyle),
          lineHeight: codeBlockLineHeight(props.textStyle),
        }}
      >
        {props.content}
      </MarkdownTextPrimitive>
    );
  }
  const highlighted = props.highlighted;
  let sourceOffset = 0;
  const keyOccurrences = new Map<string, number>();
  const keyedLines = highlighted.map((line) => {
    const lineStart = sourceOffset;
    const tokens = line.map((token) => {
      const start = sourceOffset;
      sourceOffset += token.content.length;
      const signature = `${start}:${token.content}:${token.color ?? ""}:${token.fontStyle ?? ""}`;
      const occurrence = keyOccurrences.get(signature) ?? 0;
      keyOccurrences.set(signature, occurrence + 1);
      return { key: `${signature}:${occurrence}`, token };
    });
    sourceOffset += 1;
    return {
      key: `line:${lineStart}:${line.map((token) => token.content).join("")}`,
      tokens,
    };
  });

  return (
    <MarkdownTextPrimitive
      uiTextView
      selectable
      style={{
        color: props.textStyle.codeColor,
        fontFamily: "ui-monospace",
        fontSize: codeBlockFontSize(props.textStyle),
        lineHeight: codeBlockLineHeight(props.textStyle),
      }}
    >
      {keyedLines.map((line, lineIndex) => (
        <MarkdownTextPrimitive key={line.key}>
          {line.tokens.map(({ key, token }) => (
            <MarkdownTextPrimitive
              key={key}
              style={{
                color: token.color ?? props.textStyle.codeColor,
                fontFamily: "ui-monospace",
                fontStyle:
                  token.fontStyle !== null && (token.fontStyle & 1) === 1 ? "italic" : "normal",
                fontWeight: token.fontStyle !== null && (token.fontStyle & 2) === 2 ? "700" : "400",
              }}
            >
              {token.content}
            </MarkdownTextPrimitive>
          ))}
          {lineIndex + 1 < keyedLines.length ? "\n" : ""}
        </MarkdownTextPrimitive>
      ))}
    </MarkdownTextPrimitive>
  );
}

export function NativeCodeBlock(props: {
  readonly node: MarkdownNode;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly compact?: boolean;
}) {
  const content = nodeText(props.node).replace(/\n$/, "");
  const colorScheme = useColorScheme();
  const theme = colorScheme === "dark" ? "dark" : "light";
  const highlighted = useHighlightedCode(content, props.node.language, theme, props.highlightCode);
  const languageLabel = props.node.language?.toUpperCase() ?? "CODE";
  return (
    <View
      style={{
        backgroundColor: props.textStyle.codeBlockBackgroundColor,
        borderColor: props.textStyle.dividerColor,
        borderCurve: "continuous",
        borderRadius: 10,
        borderWidth: 1,
        marginVertical: props.compact ? 7 : 0,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          minHeight: 42,
          borderBottomColor: props.textStyle.dividerColor,
          borderBottomWidth: 1,
          paddingLeft: 14,
          paddingRight: 6,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text
          selectable
          style={{
            flex: 1,
            color: props.textStyle.mutedColor,
            fontFamily: "ui-monospace",
            fontSize: codeBlockFontSize(props.textStyle),
          }}
        >
          {languageLabel}
        </Text>
        <CopyTextButton
          accessibilityLabel={`Copy ${languageLabel.toLowerCase()} code`}
          text={content}
          tintColor={props.textStyle.mutedColor}
          copiedTintColor={props.textStyle.linkColor}
          backgroundColor={props.textStyle.codeBackgroundColor}
          borderColor={props.textStyle.dividerColor}
          buttonSize={34}
          iconSize={14}
        />
      </View>
      <ScrollView
        horizontal
        bounces={false}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12 }}
      >
        <HighlightedCodeText
          content={content}
          highlighted={highlighted}
          textStyle={props.textStyle}
        />
      </ScrollView>
    </View>
  );
}
